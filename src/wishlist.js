// Wishlist API: family wish lists, "purchased" marks hidden from the list owner, and private gift ideas.
// Binding (wrangler.jsonc): DB (D1 database "wishlist"). Schema: migrations/0001_wishlist.sql.
//
// Sign-in is the honor system: a family join code plus picking your name, with an optional 4-digit PIN.
// Each signed-in device gets a random token (header X-Wishlist-Token) that maps to a member.
//
// Privacy rules enforced here:
//   - An item's owner never gets its claims (purchased marks).
//   - Ideas are private to their author unless shared as a suggestion. A shared suggestion is visible to
//     everyone in the family except the person it's for. The person it's for never gets it in any response.
//   - Budgets and the spending tracker are only returned to their author.
//   - You only see lists of people who share a group with you.
//   - Nicknames ("Grandma" for "Jane Doe") are private to whoever set them. Every name in a response is
//     already swapped for the viewer's nickname; fullName is sent alongside where the UI needs it.
//   - A person can be in several families. An item hidden from a family (item_hidden) is never shown through
//     that family: you see it only if you share some other family with the owner where it isn't hidden.
import { json, callGemini } from "./gemini.js";

const BASE = "/api/";
const LIMITS = { nickname: 40, name: 40, group: 60, title: 200, url: 2000, notes: 1000 };

// ---------- helpers ----------

const now = () => new Date().toISOString();

// Purchased marks reset each Christmas: the season is the calendar year in New York.
const season = () =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date()));

function randomString(len, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
const newId = () => randomString(16, "abcdefghijklmnopqrstuvwxyz0123456789");
const newToken = () => randomString(40, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
// No 0/O, 1/I/L so the code is easy to read out over the phone.
const newJoinCode = () => randomString(6, "ABCDEFGHJKMNPQRSTUVWXYZ23456789");

async function hashPin(memberId, pin) {
  const data = new TextEncoder().encode(`wishlist:${memberId}:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Your nicknames for other people: Map of member id -> nickname.
async function nicknamesFor(env, meId) {
  const { results } = await env.DB.prepare("SELECT subject_id, nickname FROM nicknames WHERE author_id = ?").bind(meId).all();
  return new Map(results.map((r) => [r.subject_id, r.nickname]));
}
// Swaps the author and buyer names on an idea or claim row for the viewer's nicknames.
const renameRow = (r, nicks) => ({
  ...r,
  author_name: nicks.get(r.author_id) || r.author_name,
  buyer_name: nicks.get(r.buyer_id) || r.buyer_name,
});
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function text(value, max, field, required = false) {
  const s = typeof value === "string" ? value.trim() : "";
  if (required && !s) fail(400, `${field} is required.`);
  if (s.length > max) fail(400, `${field} is too long (max ${max} characters).`);
  return s || null;
}

function link(value) {
  const s = text(value, LIMITS.url, "Link");
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw 0;
    return u.toString();
  } catch {
    fail(400, "That link doesn't look right.");
  }
}

function cents(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) fail(400, "Price should be a number like 25 or 19.99.");
  return Math.round(n * 100);
}

function pinValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value);
  if (!/^\d{4}$/.test(s)) fail(400, "PIN must be 4 digits.");
  return s;
}

async function body(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

async function signIn(env, memberId) {
  const token = newToken();
  const t = now();
  await env.DB.prepare("INSERT INTO devices (token, member_id, created_at, last_seen) VALUES (?, ?, ?, ?)")
    .bind(token, memberId, t, t)
    .run();
  return token;
}

// Returns the signed-in member or throws 401.
async function auth(request, env) {
  const token = request.headers.get("x-wishlist-token");
  if (!token) fail(401, "Not signed in.");
  const me = await env.DB.prepare(
    "SELECT m.id, m.name, m.pin_hash FROM devices d JOIN members m ON m.id = d.member_id WHERE d.token = ?",
  )
    .bind(token)
    .first();
  if (!me) fail(401, "Signed out. Join your family again.");
  // Touch last_seen at most once a day to keep writes low.
  await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE token = ? AND last_seen < ?")
    .bind(now(), token, new Date(Date.now() - 86_400_000).toISOString())
    .run();
  return { id: me.id, name: me.name, hasPin: !!me.pin_hash, token };
}

async function sharesGroup(env, a, b) {
  if (a === b) return true;
  const row = await env.DB.prepare(
    "SELECT 1 FROM group_members x JOIN group_members y ON x.group_id = y.group_id WHERE x.member_id = ? AND y.member_id = ? LIMIT 1",
  )
    .bind(a, b)
    .first();
  return !!row;
}

// SQL condition: item `i` is visible to the viewer (bound once as ?) through at least one shared family
// that the owner hasn't hidden it from.
const ITEM_VISIBLE = `EXISTS (
  SELECT 1 FROM group_members x JOIN group_members y ON y.group_id = x.group_id
   WHERE x.member_id = ? AND y.member_id = i.owner_id
     AND NOT EXISTS (SELECT 1 FROM item_hidden h WHERE h.item_id = i.id AND h.group_id = x.group_id))`;

async function myGroupIds(env, memberId) {
  const { results } = await env.DB.prepare("SELECT group_id FROM group_members WHERE member_id = ?").bind(memberId).all();
  return results.map((r) => r.group_id);
}

async function newUniqueJoinCode(env) {
  for (let i = 0; i < 5; i++) {
    const c = newJoinCode();
    if (!(await env.DB.prepare("SELECT 1 FROM groups WHERE join_code = ?").bind(c).first())) return c;
  }
  fail(500, "Couldn't make a family code. Try again.");
}

async function groupByCode(env, code) {
  const c = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!c) fail(400, "Enter your family code.");
  const group = await env.DB.prepare("SELECT id, name, join_code FROM groups WHERE join_code = ?").bind(c).first();
  if (!group) fail(404, "No family found with that code. Check it and try again.");
  return group;
}

const itemOut = (r) => ({
  id: r.id,
  title: r.title,
  url: r.url,
  price_cents: r.price_cents,
  notes: r.notes,
  priority: r.priority,
  created_at: r.created_at,
});

// Expects the idea row joined with its claim (buyer_id, buyer_name, paid_cents) and author_name.
const ideaOut = (r, meId) => ({
  id: r.id,
  subject_id: r.subject_id,
  author_id: r.author_id,
  author_name: r.author_name,
  mine: r.author_id === meId,
  title: r.title,
  url: r.url,
  price_cents: r.price_cents,
  note: r.note,
  shared: !!r.shared,
  updated_at: r.updated_at,
  claim: r.buyer_id
    ? { buyerId: r.buyer_id, buyerName: r.buyer_name, mine: r.buyer_id === meId, price_cents: r.paid_cents }
    : null,
});

// Ideas joined with author name and this season's claim.
const IDEA_SELECT = `SELECT p.*, a.name AS author_name, c.buyer_id, b.name AS buyer_name, c.price_cents AS paid_cents
   FROM private_ideas p
   JOIN members a ON a.id = p.author_id
   LEFT JOIN idea_claims c ON c.idea_id = p.id AND c.season = ?
   LEFT JOIN members b ON b.id = c.buyer_id`;

// Can `viewer` see this idea? Author always; others only if it's shared (or they already bought it),
// they aren't the person it's for, and they share a group with both people.
async function canSeeIdea(env, viewerId, idea) {
  if (idea.author_id === viewerId) return true;
  if (idea.subject_id === viewerId) return false;
  if (!idea.shared && idea.buyer_id !== viewerId) return false;
  return (await sharesGroup(env, viewerId, idea.subject_id)) && (await sharesGroup(env, viewerId, idea.author_id));
}

async function setIdeaClaim(env, me, ideaId, on, price) {
  const s = season();
  const idea = await env.DB.prepare(
    `SELECT p.*, c.buyer_id FROM private_ideas p LEFT JOIN idea_claims c ON c.idea_id = p.id AND c.season = ? WHERE p.id = ?`,
  )
    .bind(s, ideaId)
    .first();
  if (!idea || !(await canSeeIdea(env, me.id, idea))) fail(404, "Idea not found.");
  const paid = cents(price);
  if (on) {
    if (idea.buyer_id && idea.buyer_id !== me.id) fail(409, "Someone already marked this as purchased.");
    if (idea.buyer_id) {
      await env.DB.prepare("UPDATE idea_claims SET price_cents = ? WHERE idea_id = ? AND season = ?").bind(paid, ideaId, s).run();
    } else {
      await env.DB.prepare("INSERT INTO idea_claims (idea_id, season, buyer_id, price_cents, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(ideaId, s, me.id, paid, now())
        .run();
    }
  } else if (idea.buyer_id) {
    if (idea.buyer_id !== me.id) fail(403, "Only the person who marked it can undo that.");
    await env.DB.prepare("DELETE FROM idea_claims WHERE idea_id = ? AND season = ?").bind(ideaId, s).run();
  }
}

// ---------- link preview (autofill a wish from a URL) ----------

const decode = (s) =>
  String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(ndash|mdash);/g, "-").replace(/&(rsquo|lsquo);/g, "'").replace(/&(ldquo|rdquo);/g, '"')
    .replace(/&(trade|reg|copy);/g, "").replace(/&hellip;/g, "...")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function meta(html, ...names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content);
  }
  return null;
}

const toPrice = (v) => {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null;
};

// Finds a schema.org Product in JSON-LD blocks (most stores include one).
function jsonLdProduct(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const queue = [data];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) { queue.push(...node); continue; }
      const type = [].concat(node["@type"] || []).join(" ");
      if (/Product/i.test(type)) {
        const offers = [].concat(node.offers || []);
        const offer = offers[0] || {};
        const price = toPrice(offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price ?? [].concat(offer.offers || [])[0]?.price);
        return { title: node.name ? decode(node.name) : null, price };
      }
      if (node["@graph"]) queue.push(node["@graph"]);
    }
  }
  return {};
}

function cleanTitle(title, host, siteName) {
  if (!title) return null;
  let t = title.replace(/^Amazon\.com\s*:\s*/i, "");
  if (/amazon\./i.test(host)) t = t.replace(/\s+:\s+[^:]*$/, ""); // Amazon appends " : Category"
  // Drop a trailing " | Store" / " - Store" when it names the store (by site name or domain).
  const label = host.replace(/^www\./, "").split(".")[0].toLowerCase();
  const m = t.match(/^(.*\S)\s+[|\-–—:]\s+([^|\-–—:]{2,40})$/);
  if (m) {
    const suffix = m[2].toLowerCase().replace(/[^a-z0-9]/g, "");
    const site = (siteName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (suffix && (suffix === site || (suffix.length >= 4 && site.includes(suffix)) || label.includes(suffix) || suffix.includes(label))) t = m[1];
  }
  return t.slice(0, LIMITS.title).trim() || null;
}

// Last resort when a store blocks us: turn the URL slug into a name ("/Cozy-Slippers/dp/..." -> "Cozy Slippers").
function titleFromPath(u) {
  const parts = u.pathname.split("/").filter((p) => p && !/^(dp|p|product|products|ip|gp|item|itm|s)$/i.test(p) && !/^[A-Z0-9]{8,}$/.test(p));
  const slug = parts.sort((a, b) => b.length - a.length)[0];
  if (!slug || slug.length < 6 || /^\d+$/.test(slug)) return null;
  const words = decodeURIComponent(slug).replace(/\.\w+$/, "").replace(/[-_+]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function previewLink(env, rawUrl) {
  const url = new URL(link(rawUrl) || fail(400, "Paste a link first."));
  const host = url.hostname;
  let html = "";
  let finalUrl = url;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(7000),
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    finalUrl = new URL(res.url || url);
    if (res.ok && /html/i.test(res.headers.get("content-type") || "")) html = (await res.text()).slice(0, 1_500_000);
  } catch {
    // Unreachable or slow: fall through to the URL-based guess.
  }

  let title = null, price = null, siteName = null;
  if (html) {
    siteName = meta(html, "og:site_name");
    const ld = jsonLdProduct(html);
    title = ld.title
      || decode(html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)</i)?.[1]) // Amazon
      || meta(html, "og:title", "twitter:title")
      || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    price = ld.price
      ?? toPrice(meta(html, "product:price:amount", "og:price:amount", "price", "twitter:data1"))
      ?? toPrice(html.match(/class=["']a-offscreen["'][^>]*>\s*\$?([\d,.]+)/i)?.[1]); // Amazon
    // Captcha and bot-check pages have useless titles.
    if (/robot check|captcha|access denied|just a moment|attention required|page not found|^amazon\.com$/i.test(title || "")) title = null;
  }

  title = cleanTitle(title, finalUrl.hostname, siteName) || titleFromPath(finalUrl) || titleFromPath(url);
  return { url: finalUrl.toString(), title, price, site: finalUrl.hostname.replace(/^www\./, ""), found: !!html };
}

// ---------- photo to suggestions ----------

const IDENTIFY_PROMPT = `You help someone add an item to a gift wish list from a photo they took or uploaded.
Look at the main product in the photo and suggest up to 4 specific products it could be, most likely first.
Read any visible brand names, logos, labels, or model numbers. Prefer exact brand and model when you can tell;
otherwise give a clear generic name a shopper would search for (for example "Women's grey knit cardigan").
For each suggestion give:
- title: a short shopping name, under 70 characters, brand first when known
- detail: one short line on how it differs from the others (color, size, model, version)
- search: the words to type into a shopping search to find it
- price_low and price_high: a typical new retail price range in US dollars, or null if you have no idea
If the photo has no product in it, return an empty list.`;

const IDENTIFY_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          search: { type: "string" },
          price_low: { type: "number", nullable: true },
          price_high: { type: "number", nullable: true },
        },
        required: ["title", "detail", "search", "price_low", "price_high"],
      },
    },
  },
  required: ["suggestions"],
};

// ---------- handlers ----------

const handlers = {
  // Step 1 of joining: show the family name and who is already in it.
  async "POST lookup"(req, env) {
    const group = await groupByCode(env, (await body(req)).code);
    const { results } = await env.DB.prepare(
      "SELECT m.id, m.name, m.pin_hash FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? ORDER BY m.name COLLATE NOCASE",
    )
      .bind(group.id)
      .all();
    return {
      group: { name: group.name },
      members: results.map((m) => ({ id: m.id, name: m.name, hasPin: !!m.pin_hash })),
    };
  },

  // Step 2: sign in as an existing member (memberId, plus PIN if they set one) or add yourself (name).
  async "POST join"(req, env) {
    const b = await body(req);
    const group = await groupByCode(env, b.code);
    let member;
    if (b.memberId) {
      member = await env.DB.prepare(
        "SELECT m.id, m.pin_hash FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND m.id = ?",
      )
        .bind(group.id, b.memberId)
        .first();
      if (!member) fail(404, "That person isn't in this family.");
    } else {
      const name = text(b.name, LIMITS.name, "Name", true);
      member = await env.DB.prepare(
        "SELECT m.id, m.pin_hash FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND m.name = ? COLLATE NOCASE",
      )
        .bind(group.id, name)
        .first();
      if (!member) {
        const pin = pinValue(b.pin);
        const id = newId();
        const t = now();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO members (id, name, pin_hash, created_at) VALUES (?, ?, ?, ?)").bind(
            id,
            name,
            pin ? await hashPin(id, pin) : null,
            t,
          ),
          env.DB.prepare("INSERT INTO group_members (group_id, member_id, joined_at) VALUES (?, ?, ?)").bind(group.id, id, t),
        ]);
        return { token: await signIn(env, id) };
      }
    }
    if (member.pin_hash) {
      if (!b.pin) fail(403, "PIN required.");
      if ((await hashPin(member.id, String(b.pin))) !== member.pin_hash) fail(403, "Wrong PIN.");
    }
    return { token: await signIn(env, member.id) };
  },

  // Start a new family: creates the group, its join code, and you as its first member.
  async "POST start"(req, env) {
    const b = await body(req);
    const groupName = text(b.groupName, LIMITS.group, "Family name", true);
    const name = text(b.name, LIMITS.name, "Your name", true);
    const pin = pinValue(b.pin);
    const groupId = newId();
    const memberId = newId();
    const t = now();
    const code = await newUniqueJoinCode(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO groups (id, name, join_code, created_at) VALUES (?, ?, ?, ?)").bind(groupId, groupName, code, t),
      env.DB.prepare("INSERT INTO members (id, name, pin_hash, created_at) VALUES (?, ?, ?, ?)").bind(
        memberId,
        name,
        pin ? await hashPin(memberId, pin) : null,
        t,
      ),
      env.DB.prepare("INSERT INTO group_members (group_id, member_id, joined_at) VALUES (?, ?, ?)").bind(groupId, memberId, t),
    ]);
    return { token: await signIn(env, memberId) };
  },

  // Who you are, your groups, and everyone in them with their item counts.
  async "GET me"(req, env) {
    const me = await auth(req, env);
    const { results: groups } = await env.DB.prepare(
      "SELECT g.id, g.name, g.join_code FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.member_id = ? ORDER BY gm.joined_at",
    )
      .bind(me.id)
      .all();
    const { results: people } = await env.DB.prepare(
      `SELECT gm.group_id, m.id, m.name,
              (SELECT COUNT(*) FROM items i WHERE i.owner_id = m.id AND i.removed_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM item_hidden h WHERE h.item_id = i.id AND h.group_id = gm.group_id)) AS item_count
         FROM group_members gm JOIN members m ON m.id = gm.member_id
        WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_id = ?)
        ORDER BY m.name COLLATE NOCASE`,
    )
      .bind(me.id)
      .all();
    const nicks = await nicknamesFor(env, me.id);
    const person = (p) => ({ id: p.id, name: nicks.get(p.id) || p.name, fullName: p.name, itemCount: p.item_count });
    return {
      me: { id: me.id, name: me.name, hasPin: me.hasPin },
      season: season(),
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        code: g.join_code,
        members: people.filter((p) => p.group_id === g.id).map(person).sort(byName),
      })),
    };
  },

  // A member's wish list. Purchased marks are included only when you are not the owner.
  async "GET list"(req, env, url) {
    const me = await auth(req, env);
    const memberId = url.searchParams.get("member") || me.id;
    if (!(await sharesGroup(env, me.id, memberId))) fail(404, "List not found.");
    const member = await env.DB.prepare("SELECT id, name FROM members WHERE id = ?").bind(memberId).first();
    if (!member) fail(404, "List not found.");
    const own = memberId === me.id;
    const nicks = own ? new Map() : await nicknamesFor(env, me.id);
    member.fullName = member.name;
    member.name = nicks.get(member.id) || member.name;

    if (own) {
      const { results } = await env.DB.prepare(
        "SELECT * FROM items WHERE owner_id = ? AND removed_at IS NULL ORDER BY (priority = 'must') DESC, created_at",
      )
        .bind(me.id)
        .all();
      const { results: hidden } = await env.DB.prepare(
        "SELECT h.item_id, h.group_id FROM item_hidden h JOIN items i ON i.id = h.item_id WHERE i.owner_id = ?",
      )
        .bind(me.id)
        .all();
      return {
        member,
        own,
        items: results.map((r) => ({
          ...itemOut(r),
          hiddenFrom: hidden.filter((h) => h.item_id === r.id).map((h) => h.group_id),
        })),
      };
    }

    const { results } = await env.DB.prepare(
      `SELECT i.*, c.buyer_id, b.name AS buyer_name, c.price_cents AS paid_cents
         FROM items i
         LEFT JOIN claims c ON c.item_id = i.id AND c.season = ?
         LEFT JOIN members b ON b.id = c.buyer_id
        WHERE i.owner_id = ? AND (i.removed_at IS NULL OR c.item_id IS NOT NULL)
          AND (${ITEM_VISIBLE} OR c.buyer_id = ?)
        ORDER BY (c.item_id IS NOT NULL), (i.priority = 'must') DESC, i.created_at`,
    )
      .bind(season(), memberId, me.id, me.id)
      .all();
    // Suggestions shared by others, plus your own ideas (shared or not) for this person.
    const { results: ideas } = await env.DB.prepare(
      `${IDEA_SELECT}
        WHERE p.subject_id = ? AND (p.author_id = ? OR p.shared = 1 OR c.buyer_id = ?)
        ORDER BY (c.buyer_id IS NOT NULL), p.created_at`,
    )
      .bind(season(), memberId, me.id, me.id)
      .all();
    const visible = [];
    for (const r of ideas) if (await canSeeIdea(env, me.id, r)) visible.push(ideaOut(renameRow(r, nicks), me.id));
    return {
      member,
      own,
      items: results.map((r) => ({
        ...itemOut(r),
        removed: !!r.removed_at,
        claim: r.buyer_id
          ? { buyerId: r.buyer_id, buyerName: nicks.get(r.buyer_id) || r.buyer_name, mine: r.buyer_id === me.id, price_cents: r.paid_cents }
          : null,
      })),
      suggestions: visible.filter((i) => !i.mine),
      myIdeas: visible.filter((i) => i.mine),
    };
  },

  // Add (no id) or edit (id) one of your own items.
  async "POST item/save"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const fields = [
      text(b.title, LIMITS.title, "Title", true),
      link(b.url),
      cents(b.price),
      text(b.notes, LIMITS.notes, "Notes"),
      b.priority === "must" ? "must" : null,
    ];
    const t = now();
    // hiddenFrom: family ids to hide this item from (absent = leave as is). Only your own families count.
    const hideRows = (id) => async () => {
      if (!Array.isArray(b.hiddenFrom)) return [];
      const mine = new Set(await myGroupIds(env, me.id));
      const ids = [...new Set(b.hiddenFrom.map(String))].filter((g) => mine.has(g));
      return [
        env.DB.prepare("DELETE FROM item_hidden WHERE item_id = ?").bind(id),
        ...ids.map((g) => env.DB.prepare("INSERT INTO item_hidden (item_id, group_id) VALUES (?, ?)").bind(id, g)),
      ];
    };
    if (b.id) {
      const res = await env.DB.prepare(
        "UPDATE items SET title = ?, url = ?, price_cents = ?, notes = ?, priority = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND removed_at IS NULL",
      )
        .bind(...fields, t, b.id, me.id)
        .run();
      if (!res.meta.changes) fail(404, "Item not found.");
      const rows = await hideRows(b.id)();
      if (rows.length) await env.DB.batch(rows);
      return { id: b.id };
    }
    const id = newId();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO items (id, owner_id, title, url, price_cents, notes, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, me.id, ...fields, t, t),
      ...(await hideRows(id)()),
    ]);
    return { id };
  },

  // Remove one of your items. If someone already bought it, keep it for them (flagged "removed").
  async "POST item/remove"(req, env) {
    const me = await auth(req, env);
    const { id } = await body(req);
    const item = await env.DB.prepare("SELECT id FROM items WHERE id = ? AND owner_id = ? AND removed_at IS NULL")
      .bind(id, me.id)
      .first();
    if (!item) fail(404, "Item not found.");
    const claimed = await env.DB.prepare("SELECT 1 FROM claims WHERE item_id = ? AND season = ?").bind(id, season()).first();
    if (claimed) {
      await env.DB.prepare("UPDATE items SET removed_at = ? WHERE id = ?").bind(now(), id).run();
    } else {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM claims WHERE item_id = ?").bind(id),
        env.DB.prepare("DELETE FROM item_hidden WHERE item_id = ?").bind(id),
        env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id),
      ]);
    }
    return { ok: true };
  },

  // Mark (on: true) or unmark someone else's item as purchased. Only the buyer can unmark.
  // price: what you paid (optional). Marking again with a new price updates it.
  async "POST claim"(req, env) {
    const me = await auth(req, env);
    const { itemId, on, price } = await body(req);
    const paid = cents(price);
    const item = await env.DB.prepare(`SELECT i.id, i.owner_id, i.removed_at, ${ITEM_VISIBLE} AS visible FROM items i WHERE i.id = ?`)
      .bind(me.id, itemId)
      .first();
    if (!item) fail(404, "Item not found.");
    if (item.owner_id === me.id) fail(400, "You can't mark your own items.");
    const s = season();
    const existing = await env.DB.prepare("SELECT buyer_id FROM claims WHERE item_id = ? AND season = ?").bind(itemId, s).first();
    // Hidden from all your shared families: only the person who already bought it can still change their mark.
    if (!item.visible && existing?.buyer_id !== me.id) fail(404, "Item not found.");
    if (on) {
      if (existing && existing.buyer_id !== me.id) fail(409, "Someone already marked this as purchased.");
      if (existing) {
        await env.DB.prepare("UPDATE claims SET price_cents = ? WHERE item_id = ? AND season = ?").bind(paid, itemId, s).run();
      } else {
        if (item.removed_at) fail(400, "This item was removed from the list.");
        await env.DB.prepare("INSERT INTO claims (item_id, season, buyer_id, price_cents, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(itemId, s, me.id, paid, now())
          .run();
      }
    } else if (existing) {
      if (existing.buyer_id !== me.id) fail(403, "Only the person who marked it can undo that.");
      await env.DB.prepare("DELETE FROM claims WHERE item_id = ? AND season = ?").bind(itemId, s).run();
      // An item the owner already removed disappears once nobody has bought it.
      if (item.removed_at) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM item_hidden WHERE item_id = ?").bind(itemId),
          env.DB.prepare("DELETE FROM items WHERE id = ?").bind(itemId),
        ]);
      }
    }
    return { ok: true };
  },

  // Your private ideas, optionally for one person (?subject=id).
  async "GET ideas"(req, env, url) {
    const me = await auth(req, env);
    const subject = url.searchParams.get("subject");
    const { results } = await env.DB.prepare(
      `${IDEA_SELECT} WHERE p.author_id = ?${subject ? " AND p.subject_id = ?" : ""} ORDER BY (c.buyer_id IS NOT NULL), p.updated_at DESC`,
    )
      .bind(season(), me.id, ...(subject ? [subject] : []))
      .all();
    const nicks = await nicknamesFor(env, me.id);
    return { ideas: results.map((r) => ideaOut(renameRow(r, nicks), me.id)) };
  },

  async "POST idea/save"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const fields = [
      text(b.title, LIMITS.title, "Idea", true),
      link(b.url),
      cents(b.price),
      text(b.note, LIMITS.notes, "Note"),
      b.shared ? 1 : 0,
    ];
    const t = now();
    let id = b.id;
    if (id) {
      const res = await env.DB.prepare(
        "UPDATE private_ideas SET title = ?, url = ?, price_cents = ?, note = ?, shared = ?, updated_at = ? WHERE id = ? AND author_id = ?",
      )
        .bind(...fields, t, id, me.id)
        .run();
      if (!res.meta.changes) fail(404, "Idea not found.");
    } else {
      if (!b.subjectId || b.subjectId === me.id || !(await sharesGroup(env, me.id, b.subjectId))) fail(400, "Pick who this idea is for.");
      id = newId();
      await env.DB.prepare(
        "INSERT INTO private_ideas (id, author_id, subject_id, title, url, price_cents, note, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, me.id, b.subjectId, ...fields, t, t)
        .run();
    }
    // "I bought this" on your own idea is the same as marking it purchased.
    if (b.bought !== undefined) await setIdeaClaim(env, me, id, !!b.bought, b.paid);
    return { id };
  },

  async "POST idea/remove"(req, env) {
    const me = await auth(req, env);
    const { id } = await body(req);
    const idea = await env.DB.prepare("SELECT id FROM private_ideas WHERE id = ? AND author_id = ?").bind(id, me.id).first();
    if (!idea) fail(404, "Idea not found.");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM idea_claims WHERE idea_id = ?").bind(id),
      env.DB.prepare("DELETE FROM private_ideas WHERE id = ?").bind(id),
    ]);
    return { ok: true };
  },

  // Mark (on: true) or unmark an idea or shared suggestion as purchased, with optional price paid.
  async "POST idea/claim"(req, env) {
    const me = await auth(req, env);
    const { ideaId, on, price } = await body(req);
    await setIdeaClaim(env, me, ideaId, !!on, price);
    return { ok: true };
  },

  // Set (amount) or clear (empty amount) your budget for one person this season.
  async "POST budget"(req, env) {
    const me = await auth(req, env);
    const { subjectId, amount } = await body(req);
    if (!subjectId || subjectId === me.id || !(await sharesGroup(env, me.id, subjectId))) fail(400, "Pick who this budget is for.");
    const value = cents(amount);
    if (value === null) {
      await env.DB.prepare("DELETE FROM budgets WHERE author_id = ? AND subject_id = ? AND season = ?").bind(me.id, subjectId, season()).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO budgets (author_id, subject_id, season, amount_cents) VALUES (?, ?, ?, ?) ON CONFLICT (author_id, subject_id, season) DO UPDATE SET amount_cents = excluded.amount_cents",
      )
        .bind(me.id, subjectId, season(), value)
        .run();
    }
    return { ok: true };
  },

  // Autofill: read a product link and return its name and price (nothing is saved).
  async "POST preview"(req, env) {
    await auth(req, env);
    const { url } = await body(req);
    return previewLink(env, url);
  },

  // Photo to suggestions: Gemini guesses what the item is. Nothing is stored.
  async "POST identify"(req, env) {
    await auth(req, env);
    if (!env.GEMINI_API_KEY) fail(500, "Photo search isn't set up (missing GEMINI_API_KEY).");
    const { image } = await body(req);
    const match = typeof image === "string" && image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) fail(400, "That photo didn't come through. Try again.");
    if (match[2].length > 4_000_000) fail(400, "That photo is too large. Try a smaller one.");
    const result = await callGemini(env, IDENTIFY_PROMPT, [{ inline_data: { mime_type: match[1], data: match[2] } }], IDENTIFY_SCHEMA, 25000);
    if (result.error) return result.error;
    const clean = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const dollars = (v) => (typeof v === "number" && v > 0 && v < 100_000 ? Math.round(v) : null);
    const suggestions = (result.data?.suggestions || [])
      .map((x) => ({
        title: clean(x.title, LIMITS.title),
        detail: clean(x.detail, 160),
        search: clean(x.search, 150) || clean(x.title, 150),
        price_low: dollars(x.price_low),
        price_high: dollars(x.price_high),
      }))
      .filter((x) => x.title)
      .slice(0, 4);
    return { suggestions };
  },

  // Your private planner for this season: per person budget, what you bought (list items and ideas)
  // with what you paid, and your ideas. Only ever about other people, only ever for you.
  async "GET tracker"(req, env) {
    const me = await auth(req, env);
    const s = season();
    const [people, budgets, itemBuys, ideaBuys, ideas] = await Promise.all([
      env.DB.prepare(
        `SELECT DISTINCT m.id, m.name FROM group_members gm JOIN members m ON m.id = gm.member_id
          WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_id = ?) AND m.id != ?
          ORDER BY m.name COLLATE NOCASE`,
      ).bind(me.id, me.id).all(),
      env.DB.prepare("SELECT subject_id, amount_cents FROM budgets WHERE author_id = ? AND season = ?").bind(me.id, s).all(),
      env.DB.prepare(
        `SELECT i.owner_id AS subject_id, i.id, i.title, i.url, i.price_cents AS list_cents, c.price_cents AS paid_cents, c.created_at
           FROM claims c JOIN items i ON i.id = c.item_id WHERE c.buyer_id = ? AND c.season = ? ORDER BY c.created_at`,
      ).bind(me.id, s).all(),
      env.DB.prepare(
        `SELECT p.subject_id, p.id, p.title, p.url, p.price_cents AS list_cents, c.price_cents AS paid_cents, c.created_at,
                p.author_id, a.name AS author_name
           FROM idea_claims c JOIN private_ideas p ON p.id = c.idea_id JOIN members a ON a.id = p.author_id
          WHERE c.buyer_id = ? AND c.season = ? ORDER BY c.created_at`,
      ).bind(me.id, s).all(),
      env.DB.prepare(`${IDEA_SELECT} WHERE p.author_id = ? AND c.buyer_id IS NULL ORDER BY p.updated_at DESC`).bind(s, me.id).all(),
    ]);
    const nicks = await nicknamesFor(env, me.id);
    const budgetOf = new Map(budgets.results.map((b) => [b.subject_id, b.amount_cents]));
    const purchase = (kind) => (r) => ({
      kind,
      id: r.id,
      subject_id: r.subject_id,
      title: r.title,
      url: r.url,
      list_cents: r.list_cents,
      paid_cents: r.paid_cents,
      spent_cents: r.paid_cents ?? r.list_cents ?? 0,
      date: r.created_at,
      from: kind === "item" ? "Their list" : r.author_id === me.id ? "My idea" : `Suggested by ${nicks.get(r.author_id) || r.author_name}`,
    });
    const purchases = [...itemBuys.results.map(purchase("item")), ...ideaBuys.results.map(purchase("idea"))];
    return {
      season: s,
      people: people.results.map((p) => {
        const bought = purchases.filter((x) => x.subject_id === p.id);
        return {
          id: p.id,
          name: nicks.get(p.id) || p.name,
          fullName: p.name,
          budget_cents: budgetOf.get(p.id) ?? null,
          spent_cents: bought.reduce((sum, x) => sum + x.spent_cents, 0),
          purchases: bought,
          ideas: ideas.results.filter((r) => r.subject_id === p.id).map((r) => ideaOut(renameRow(r, nicks), me.id)),
        };
      }).sort(byName),
    };
  },

  // Your own name for someone (only you see it). An empty nickname goes back to their real name.
  async "POST nickname"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    if (!b.subjectId || b.subjectId === me.id || !(await sharesGroup(env, me.id, b.subjectId))) fail(400, "Pick who to rename.");
    const nickname = text(b.nickname, LIMITS.nickname, "Nickname");
    if (nickname === null) {
      await env.DB.prepare("DELETE FROM nicknames WHERE author_id = ? AND subject_id = ?").bind(me.id, b.subjectId).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO nicknames (author_id, subject_id, nickname, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (author_id, subject_id) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at",
      )
        .bind(me.id, b.subjectId, nickname, now())
        .run();
    }
    return { ok: true };
  },

  // Join another family while signed in, so the same you (and the same list) is in both.
  async "POST family/join"(req, env) {
    const me = await auth(req, env);
    const group = await groupByCode(env, (await body(req)).code);
    if ((await myGroupIds(env, me.id)).includes(group.id)) fail(409, `You're already in ${group.name}.`);
    // Signing in by name picks the first match, so two people with the same name in one family would clash.
    const clash = await env.DB.prepare(
      "SELECT 1 FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND m.name = ? COLLATE NOCASE",
    )
      .bind(group.id, me.name)
      .first();
    if (clash) fail(409, `Someone named ${me.name} is already in ${group.name}. Change your name above (for example, add a last initial), then join.`);
    await env.DB.prepare("INSERT INTO group_members (group_id, member_id, joined_at) VALUES (?, ?, ?)").bind(group.id, me.id, now()).run();
    return { group: { id: group.id, name: group.name } };
  },

  // Start another family while signed in.
  async "POST family/start"(req, env) {
    const me = await auth(req, env);
    const name = text((await body(req)).groupName, LIMITS.group, "Family name", true);
    const id = newId();
    const t = now();
    const code = await newUniqueJoinCode(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO groups (id, name, join_code, created_at) VALUES (?, ?, ?, ?)").bind(id, name, code, t),
      env.DB.prepare("INSERT INTO group_members (group_id, member_id, joined_at) VALUES (?, ?, ?)").bind(id, me.id, t),
    ]);
    return { group: { id, name, code } };
  },

  // Leave one of your families (not your last one). Your list stays; that family just stops seeing it.
  async "POST family/leave"(req, env) {
    const me = await auth(req, env);
    const { groupId } = await body(req);
    const mine = await myGroupIds(env, me.id);
    if (!mine.includes(groupId)) fail(404, "Family not found.");
    if (mine.length < 2) fail(400, "You can't leave your only family.");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND member_id = ?").bind(groupId, me.id),
      env.DB.prepare("DELETE FROM item_hidden WHERE group_id = ? AND item_id IN (SELECT id FROM items WHERE owner_id = ?)").bind(groupId, me.id),
    ]);
    return { ok: true };
  },

  // Change your name and/or PIN. pin: "1234" sets it, "" removes it, absent leaves it alone.
  async "POST profile"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    if (b.name !== undefined) {
      const name = text(b.name, LIMITS.name, "Name", true);
      await env.DB.prepare("UPDATE members SET name = ? WHERE id = ?").bind(name, me.id).run();
    }
    if (b.pin !== undefined) {
      const pin = pinValue(b.pin);
      await env.DB.prepare("UPDATE members SET pin_hash = ? WHERE id = ?")
        .bind(pin ? await hashPin(me.id, pin) : null, me.id)
        .run();
    }
    return { ok: true };
  },

  async "POST signout"(req, env) {
    const me = await auth(req, env);
    await env.DB.prepare("DELETE FROM devices WHERE token = ?").bind(me.token).run();
    return { ok: true };
  },
};

async function handle(request, env, key) {
  if (!env.DB) return json({ error: "Wishlist database isn't set up yet (missing DB binding)." }, 500);
  try {
    const out = await handlers[key](request, env, new URL(request.url));
    return out instanceof Response ? out : json(out);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("wishlist", key, err);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
}

// One exact path per action ("POST item/save" -> /api/item/save). src/worker.js routes them.
const paths = {};
for (const key of Object.keys(handlers)) {
  const [method, action] = key.split(" ");
  (paths[BASE + action] ||= {})[method] = key;
}
export const routes = Object.fromEntries(
  Object.entries(paths).map(([path, byMethod]) => [
    path,
    (request, env) => {
      const key = byMethod[request.method];
      return key ? handle(request, env, key) : json({ error: "Method not allowed." }, 405);
    },
  ]),
);
