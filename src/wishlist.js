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
//   - Gift card gifts ("I'm giving one") are never returned to the person they're for. Any number of people
//     can give the same brand, so gift cards never show as taken.
//   - A person can be in several families. An item hidden from a family (item_hidden) is never shown through
//     that family: you see it only if you share some other family with the owner where it isn't hidden.
import { json, callGemini } from "./gemini.js";
import { STORES, STORE_KEYS, PROMPT_STORE_LIST, isBlocked, storeFor, isBrandHost, cleanBrandDomain } from "./stores.js";
// Sets globalThis.GIFT_CARDS. Shared with the app, so both sides use the same brand list.
import "../public/giftcards.js";

const BASE = "/api/";
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/;
const MAX_PHOTO = 120_000; // characters of data URL; the app sends about 10 to 20 KB
const LIMITS = { nickname: 40, name: 40, size: 30, avoid: 300, brand: 40, brands: 20, giftCards: 60, group: 60, title: 200, url: 2000, notes: 1000 };
// Wish categories. Must match CATS in public/index.html. NULL means "guess from the title" (done in the app).
const CATEGORIES = new Set(["beauty", "tech", "clothing", "shoes", "accessories", "home", "kitchen", "books", "toys", "outdoors", "treats", "experiences", "other"]);
const category = (v) => (typeof v === "string" && CATEGORIES.has(v) ? v : null);
// Gift card brands: key -> name.
const GIFT_CARD_NAMES = new Map(globalThis.GIFT_CARDS.map((g) => [g.key, g.name]));

// ---------- helpers ----------

const now = () => new Date().toISOString();

// ---------- occasions ----------
// Purchased marks and budgets belong to an occasion: Christmas for everyone, plus each person's birthday
// if they added one. An occasion is stored as its date, YYYYMMDD (the `season` columns), and counts
// through that day in New York. So a mark is "active" while its season >= today, and things reset the
// day after the occasion. A Christmas gift bought before someone's November birthday stays marked.
function todayParts() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return { y: +p.year, m: +p.month, d: +p.day };
}
const dateCode = (y, m, d) => y * 10000 + m * 100 + d;
const today = () => { const t = todayParts(); return dateCode(t.y, t.m, t.d); };
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (m, y = 2024) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
// Feb 29 birthdays fall on Feb 28 in other years.
const birthdayCode = (y, m, d) => dateCode(y, m, m === 2 && d === 29 && !isLeap(y) ? 28 : d);
const isoOf = (code) => `${Math.floor(code / 10000)}-${String(Math.floor(code / 100) % 100).padStart(2, "0")}-${String(code % 100).padStart(2, "0")}`;

// A member row's birthday (members.birthday "MM-DD", birth_year optional) as numbers, or null.
function bdayOf(m) {
  const x = typeof m?.birthday === "string" && m.birthday.match(/^(\d{2})-(\d{2})$/);
  return x ? { month: +x[1], day: +x[2], year: m.birth_year || null } : null;
}
// Upcoming occasions for a member row (birthday, birth_year), soonest first.
// Each: { code, date, christmas, birthday, turning }. A Dec 25 birthday is one occasion that's both.
function occasionsFor(m, now = today()) {
  const y = Math.floor(now / 10000);
  const xmas = dateCode(y, 12, 25) >= now ? dateCode(y, 12, 25) : dateCode(y + 1, 12, 25);
  const list = [{ code: xmas, christmas: true, birthday: false, turning: null }];
  const b = bdayOf(m);
  if (b) {
    let code = birthdayCode(y, b.month, b.day);
    if (code < now) code = birthdayCode(y + 1, b.month, b.day);
    const turning = b.year ? Math.floor(code / 10000) - b.year : null;
    const same = list.find((o) => o.code === code);
    if (same) Object.assign(same, { birthday: true, turning });
    else list.push({ code, christmas: false, birthday: true, turning });
  }
  return list.sort((a, b) => a.code - b.code).map((o) => ({ ...o, date: isoOf(o.code) }));
}

async function memberOccasions(env, memberId) {
  const m = await env.DB.prepare("SELECT birthday, birth_year FROM members WHERE id = ?").bind(memberId).first();
  return occasionsFor(m);
}
// The occasion to file a mark or budget under: the one asked for if it's one of the person's upcoming
// occasions, else `fallback` (an existing mark's), else the soonest.
async function pickOccasion(env, subjectId, wanted, fallback) {
  const codes = (await memberOccasions(env, subjectId)).map((o) => o.code);
  const w = Number(wanted);
  if (wanted !== undefined && wanted !== null && wanted !== "") {
    if (!codes.includes(w)) fail(400, "Pick Christmas or their birthday.");
    return w;
  }
  return fallback ?? codes[0];
}

// SQL: join the active (soonest not yet passed) claim. Bind today once.
const ACTIVE_CLAIM = (table, key, outer) =>
  `c.season = (SELECT MIN(c2.season) FROM ${table} c2 WHERE c2.${key} = ${outer} AND c2.season >= ?)`;

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

// Share buttons in store apps paste text plus a link ("Check out X! https://..."). Keep just the link.
// Must match splitShared() in public/index.html.
function sharedUrl(s) {
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  const m = s.match(/https?:\/\/[^\s<>"']+/i) || s.match(/(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']*/i);
  return m ? m[0].replace(/[).,!?;:'"\]]+$/, "") : s;
}

function link(value) {
  const s = text(value, LIMITS.url, "Link");
  if (!s) return null;
  const found = sharedUrl(s);
  const withScheme = /^https?:\/\//i.test(found) ? found : `https://${found}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw 0;
    return u.toString();
  } catch {
    fail(400, "That link doesn't look right.");
  }
}

// A product image URL: https only (pages are https), otherwise dropped rather than rejected.
function imageLink(value) {
  if (typeof value !== "string" || !value || value.length > LIMITS.url) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// SET clause pieces for image columns on save: a fresh image from autofill wins; otherwise keep the
// image while the link is unchanged, and clear it when the link changes so it's looked up again.
const IMAGE_SET = `image_url = CASE WHEN ?1 IS NOT NULL THEN ?1 WHEN url IS ?2 THEN image_url ELSE NULL END,
  image_checked_at = CASE WHEN ?1 IS NOT NULL THEN ?3 WHEN url IS ?2 THEN image_checked_at ELSE NULL END,
  price_checked_at = CASE WHEN url IS ?2 THEN price_checked_at ELSE NULL END`;

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
    "SELECT m.id, m.name, m.pin_hash, m.onboarded_at FROM devices d JOIN members m ON m.id = d.member_id WHERE d.token = ?",
  )
    .bind(token)
    .first();
  if (!me) fail(401, "Signed out. Join your family again.");
  // Touch last_seen at most once a day to keep writes low.
  await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE token = ? AND last_seen < ?")
    .bind(now(), token, new Date(Date.now() - 86_400_000).toISOString())
    .run();
  return { id: me.id, name: me.name, hasPin: !!me.pin_hash, onboarded: !!me.onboarded_at, token };
}

// Profile details shown to family on your list (migration 0008). Reads with SELECT * so a missing column
// just means an empty profile.
const SIZE_KEYS = ["shirt", "pants", "shoe", "ring"];
function profileOut(row) {
  let sizes = {};
  try { sizes = JSON.parse(row?.sizes || "{}") || {}; } catch {}
  return {
    birthday: row?.birthday || null,
    birthYear: row?.birthday ? row?.birth_year || null : null,
    sizes: Object.fromEntries(SIZE_KEYS.map((k) => [k, typeof sizes[k] === "string" ? sizes[k] : ""])),
    avoid: row?.avoid || "",
    brands: brandsOut(row?.brands),
  };
}
function brandsOut(v) {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a.filter((x) => typeof x === "string" && x) : [];
  } catch {
    return [];
  }
}
async function profileOf(env, memberId) {
  return profileOut(await env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(memberId).first());
}
function birthdayValue(v) {
  if (v === null || v === "") return null;
  const m = typeof v === "string" && v.match(/^(\d{2})-(\d{2})$/);
  const mo = m && Number(m[1]), d = m && Number(m[2]);
  if (!m || mo < 1 || mo > 12 || d < 1 || d > new Date(2024, mo, 0).getDate()) fail(400, "That birthday doesn't look right.");
  return v;
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

// SQL condition: item `i` is published (not in the owner's "Just me" drafts) and visible to the viewer
// (bound once as ?) through at least one shared family that the owner hasn't hidden it from.
const ITEM_VISIBLE = `i.draft = 0 AND EXISTS (
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

// For invite links (/join/CODE?from=memberId): the family's name and, if `from` is someone in that
// family, their name. Null when the code doesn't match a family. Used by the lookup API and by
// src/worker.js for the link preview (Open Graph tags).
export async function inviteInfo(env, code, fromId) {
  const c = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!c || !env.DB) return null;
  const group = await env.DB.prepare("SELECT id, name FROM groups WHERE join_code = ?").bind(c).first();
  if (!group) return null;
  let inviter = null;
  if (fromId) {
    const row = await env.DB.prepare(
      "SELECT m.name FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND m.id = ?",
    )
      .bind(group.id, String(fromId))
      .first();
    inviter = row?.name || null;
  }
  return { group, inviter };
}

// Someone's gift cards as another person sees them: the brands they picked, plus any brand you're
// giving them for an upcoming occasion that they've since removed (flagged "removed").
// mine: your gifts for upcoming occasions, [{ occasion, amount_cents }]. others: how many other people
// are giving that brand for an upcoming occasion. Gifts reset after their occasion; brands stay.
async function giftCardsFor(env, memberId, meId) {
  const t = today();
  const [{ results: cards }, { results: gifts }] = await Promise.all([
    env.DB.prepare("SELECT brand, created_at FROM gift_cards WHERE member_id = ? ORDER BY created_at, brand").bind(memberId).all(),
    env.DB.prepare("SELECT brand, season, buyer_id, amount_cents FROM gift_card_gifts WHERE member_id = ? AND season >= ? ORDER BY season")
      .bind(memberId, t)
      .all(),
  ]);
  const picked = new Set(cards.map((c) => c.brand));
  const extra = new Set(gifts.filter((g) => g.buyer_id === meId && !picked.has(g.brand)).map((g) => g.brand));
  return [...cards.map((c) => c.brand), ...extra].filter((b) => GIFT_CARD_NAMES.has(b)).map((brand) => {
    const forBrand = gifts.filter((g) => g.brand === brand);
    return {
      brand,
      removed: !picked.has(brand),
      mine: forBrand.filter((g) => g.buyer_id === meId).map((g) => ({ occasion: g.season, amount_cents: g.amount_cents })),
      others: new Set(forBrand.filter((g) => g.buyer_id !== meId).map((g) => g.buyer_id)).size,
    };
  });
}

const itemOut = (r) => ({
  id: r.id,
  title: r.title,
  url: r.url,
  price_cents: r.price_cents,
  notes: r.notes,
  priority: r.priority,
  category: r.category || null,
  draft: !!r.draft,
  created_at: r.created_at,
  updated_at: r.updated_at,
  image_url: r.image_url || null,
  image_checked: !!r.image_checked_at,
  price_checked: !!r.price_checked_at,
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
  image_url: r.image_url || null,
  image_checked: !!r.image_checked_at,
  price_checked: !!r.price_checked_at,
  updated_at: r.updated_at,
  claim: r.buyer_id
    ? { buyerId: r.buyer_id, buyerName: r.buyer_name, mine: r.buyer_id === meId, price_cents: r.paid_cents, occasion: r.claim_season }
    : null,
});

// Ideas joined with author name and their active claim. Bind today first.
const IDEA_SELECT = `SELECT p.*, a.name AS author_name, c.buyer_id, b.name AS buyer_name, c.price_cents AS paid_cents, c.season AS claim_season
   FROM private_ideas p
   JOIN members a ON a.id = p.author_id
   LEFT JOIN idea_claims c ON c.idea_id = p.id AND ${ACTIVE_CLAIM("idea_claims", "idea_id", "p.id")}
   LEFT JOIN members b ON b.id = c.buyer_id`;

// Can `viewer` see this idea? Author always; others only if it's shared (or they already bought it),
// they aren't the person it's for, and they share a group with both people.
async function canSeeIdea(env, viewerId, idea) {
  if (idea.author_id === viewerId) return true;
  if (idea.subject_id === viewerId) return false;
  if (!idea.shared && idea.buyer_id !== viewerId) return false;
  return (await sharesGroup(env, viewerId, idea.subject_id)) && (await sharesGroup(env, viewerId, idea.author_id));
}

// occasion: which of the person's occasions it's for (absent = keep the current one, or the soonest).
async function setIdeaClaim(env, me, ideaId, on, price, occasion) {
  const idea = await env.DB.prepare(
    `SELECT p.*, c.buyer_id, c.season AS claim_season FROM private_ideas p
       LEFT JOIN idea_claims c ON c.idea_id = p.id AND ${ACTIVE_CLAIM("idea_claims", "idea_id", "p.id")} WHERE p.id = ?`,
  )
    .bind(today(), ideaId)
    .first();
  if (!idea || !(await canSeeIdea(env, me.id, idea))) fail(404, "Idea not found.");
  const paid = cents(price);
  if (on) {
    if (idea.buyer_id && idea.buyer_id !== me.id) fail(409, "Someone already marked this as purchased.");
    const s = await pickOccasion(env, idea.subject_id, occasion, idea.claim_season ?? undefined);
    if (idea.buyer_id) {
      await env.DB.prepare("UPDATE idea_claims SET price_cents = ?, season = ? WHERE idea_id = ? AND season = ?")
        .bind(paid, s, ideaId, idea.claim_season).run();
    } else {
      await env.DB.prepare("INSERT INTO idea_claims (idea_id, season, buyer_id, price_cents, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(ideaId, s, me.id, paid, now())
        .run();
    }
  } else if (idea.buyer_id) {
    if (idea.buyer_id !== me.id) fail(403, "Only the person who marked it can undo that.");
    await env.DB.prepare("DELETE FROM idea_claims WHERE idea_id = ? AND season = ?").bind(ideaId, idea.claim_season).run();
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
        const img = [].concat(node.image || [])[0];
        const image = typeof img === "string" ? img : img?.url || img?.contentUrl || null;
        return { title: node.name ? decode(node.name) : null, price, image };
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

// Fetches a page like a browser would. Returns the final URL after redirects and the HTML ("" if blocked or not HTML).
async function readPage(url, timeoutMs = 7000) {
  let html = "", finalUrl = url, status = 0;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    status = res.status;
    finalUrl = new URL(res.url || url);
    if (res.ok && /html/i.test(res.headers.get("content-type") || "")) html = (await res.text()).slice(0, 1_500_000);
  } catch {
    // Unreachable or slow: html stays empty.
  }
  return { html, finalUrl, status };
}

const BOT_PAGE = /robot check|captcha|access denied|just a moment|attention required|page not found|^amazon\.com$/i;

async function previewLink(env, rawUrl) {
  const url = new URL(link(rawUrl) || fail(400, "Paste a link first."));
  const { html, finalUrl } = await readPage(url);

  let title = null, price = null, siteName = null, image = null;
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
    image = ld.image
      || meta(html, "og:image:secure_url", "og:image", "twitter:image", "twitter:image:src", "image")
      || decode(html.match(/id=["']landingImage["'][^>]*data-old-hires=["']([^"']+)["']/i)?.[1]) // Amazon
      || decode(html.match(/id=["']landingImage["'][^>]*src=["']([^"']+)["']/i)?.[1]);
    // Captcha and bot-check pages have useless titles.
    if (BOT_PAGE.test(title || "")) title = null;
  }

  title = cleanTitle(title, finalUrl.hostname, siteName) || titleFromPath(finalUrl) || titleFromPath(url);
  let imageUrl = null;
  if (image && title) {
    try { imageUrl = imageLink(new URL(image, finalUrl).toString()); } catch {}
  }
  return { url: finalUrl.toString(), title, price, image: imageUrl, site: finalUrl.hostname.replace(/^www\./, ""), found: !!html };
}

// ---------- photo to suggestions ----------

const IDENTIFY_PROMPT = `You help someone add an item to a gift wish list from a photo they took or uploaded.
Look at the main product in the photo and suggest up to 4 specific products it could be, most likely first.
Read any visible brand names, logos, labels, or model numbers. Prefer exact brand and model when you can tell;
otherwise give a clear generic name a shopper would search for (for example "Women's grey knit cardigan").
Then use Google Search to find where each one is sold new by a legitimate seller.
For each suggestion give:
- title: a short shopping name, under 70 characters, brand first when known
- detail: one short line on how it differs from the others (color, size, model, version)
- search: the words to type into a store's search box to find it
- price_low and price_high: a typical new retail price range in US dollars, or null if you have no idea
- brand_domain: the domain of the brand's own official online store (for example "nike.com"), or "" if unknown or the brand has none
- links: up to 3 product page URLs for this item that appeared in your search results, best first. Only use
  1) the brand's official site, 2) these retailers: ${PROMPT_STORE_LIST}, 3) amazon.com.
  Never use marketplaces, resellers, or used sellers (eBay, Etsy, Poshmark, Mercari, Temu, AliExpress, Shein, StockX).
  Copy each URL exactly as found. Never guess or build a URL. Product pages only, not search or category pages.
  Use an empty list if you found none.
- store: of the retailers above (or amazon), the one most likely to carry it, used to search if no link works
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
          brand_domain: { type: "string" },
          links: { type: "array", items: { type: "string" } },
          store: { type: "string", enum: STORE_KEYS },
        },
        required: ["title", "detail", "search", "price_low", "price_high", "brand_domain", "links", "store"],
      },
    },
  },
  required: ["suggestions"],
};

// Host plus path, for comparing a URL the AI wrote with one Google Search actually returned.
const urlKey = (u) => {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch { return ""; }
};

// Google Search grounding returns its sources as redirect links. Follow each once to learn the real URL.
async function resolveRedirect(uri) {
  try {
    const res = await fetch(uri, { redirect: "manual", signal: AbortSignal.timeout(4000) });
    return res.headers.get("location") || uri;
  } catch { return uri; }
}

async function groundedUrls(grounding) {
  const uris = (grounding?.groundingChunks || []).map((c) => c?.web?.uri).filter(Boolean).slice(0, 15);
  const real = await Promise.all(uris.map((u) => (/vertexaisearch\.cloud\.google\.com/.test(u) ? resolveRedirect(u) : u)));
  return new Set(real.map(urlKey).filter(Boolean));
}

// Does this page look like a single product (not a search, category, or home page)?
function looksLikeProduct(html, url) {
  if (url.pathname === "/" || /\/(search|s|sr|keyword\.php|searchpage\.jsp)$/i.test(url.pathname)) return false;
  return !!(jsonLdProduct(html).title || /^product/i.test(meta(html, "og:type") || "") || meta(html, "product:price:amount")
    || /id=["']productTitle["']/i.test(html));
}

// Amazon only counts as a trusted store when the page shows Amazon itself shipping and selling it.
const soldByAmazon = (html) =>
  /Ships from[\s\S]{0,400}?>\s*Amazon(?:\.com)?\s*</i.test(html) && /Sold by[\s\S]{0,400}?>\s*Amazon(?:\.com)?\s*</i.test(html);

// Rank: 0 brand site, 1 retailer (or Amazon selling it itself), 2 Amazon with an unknown seller. null = not allowed.
function tierFor(host, brandDomain, html) {
  if (isBlocked(host)) return null;
  if (isBrandHost(host, brandDomain)) return 0;
  const store = storeFor(host);
  if (!store) return null;
  if (store !== "amazon") return 1;
  return html && soldByAmazon(html) ? 1 : 2;
}

// Checks one URL the AI offered. Accepts it if the page loads as a product on an allowed store, or if a store
// blocked us but Google Search really returned that exact URL. Returns null to drop it.
async function checkLink(raw, brandDomain, grounded) {
  let url;
  try { url = new URL(/vertexaisearch\.cloud\.google\.com/.test(raw) ? await resolveRedirect(raw) : raw); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (tierFor(url.hostname, brandDomain, "") === null) return null;
  const { html, finalUrl } = await readPage(url, 6000);
  const page = html && !BOT_PAGE.test(decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1])) ? html : "";
  const tier = tierFor(finalUrl.hostname, brandDomain, page);
  if (tier === null) return null; // redirected somewhere we don't link to
  if (page) {
    if (!looksLikeProduct(page, finalUrl)) return null;
    const ld = jsonLdProduct(page);
    const price = ld.price ?? toPrice(meta(page, "product:price:amount", "og:price:amount"))
      ?? toPrice(page.match(/class=["']a-offscreen["'][^>]*>\s*\$?([\d,.]+)/i)?.[1]);
    return { url: finalUrl.toString(), host: finalUrl.hostname, tier, price, verified: true };
  }
  // Store blocked the check. Only trust the link if it came straight from Google Search.
  if (grounded.has(urlKey(url.toString()))) return { url: url.toString(), host: url.hostname, tier, price: null, verified: false };
  return null;
}

const storeName = (host, brandDomain) =>
  isBrandHost(host, brandDomain) ? host.replace(/^www\./, "") : STORES[storeFor(host)]?.name || host.replace(/^www\./, "");

// Picks the best confirmed link for a suggestion, or falls back to a search on the likeliest store.
async function bestLink(x, grounded) {
  const brandDomain = cleanBrandDomain(x.brand_domain);
  const raws = [...new Set((Array.isArray(x.links) ? x.links : []).filter((u) => typeof u === "string").map((u) => u.trim()))].slice(0, 3);
  const found = (await Promise.all(raws.map((u) => checkLink(u, brandDomain, grounded)))).filter(Boolean);
  // Best tier first; within a tier, a page we could read beats one we couldn't.
  found.sort((a, b) => a.tier - b.tier || b.verified - a.verified);
  const best = found[0];
  if (best) return { url: best.url, store: storeName(best.host, brandDomain), link: "product", price: best.price };
  const key = STORES[x.store] ? x.store : "target";
  return { url: STORES[key].search(x.search || x.title), store: STORES[key].name, link: "search", price: null };
}

// ---------- handlers ----------

const handlers = {
  // Step 1 of joining: show the family name and who is already in it.
  // `from` (optional) is the id of whoever sent the invite link; their name comes back as `inviter`.
  async "POST lookup"(req, env) {
    const b = await body(req);
    const group = await groupByCode(env, b.code);
    const info = b.from ? await inviteInfo(env, b.code, b.from) : null;
    const { results } = await env.DB.prepare(
      "SELECT m.id, m.name, m.pin_hash, m.photo_at FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? ORDER BY m.name COLLATE NOCASE",
    )
      .bind(group.id)
      .all();
    return {
      group: { name: group.name },
      inviter: info?.inviter || null,
      members: results.map((m) => ({ id: m.id, name: m.name, hasPin: !!m.pin_hash, photo: m.photo_at || null })),
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
      `SELECT gm.group_id, m.id, m.name, m.photo_at, m.birthday, m.birth_year,
              (SELECT COUNT(*) FROM items i WHERE i.owner_id = m.id AND i.removed_at IS NULL AND i.draft = 0
                  AND NOT EXISTS (SELECT 1 FROM item_hidden h WHERE h.item_id = i.id AND h.group_id = gm.group_id)) AS item_count
         FROM group_members gm JOIN members m ON m.id = gm.member_id
        WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_id = ?)
        ORDER BY m.name COLLATE NOCASE`,
    )
      .bind(me.id)
      .all();
    const nicks = await nicknamesFor(env, me.id);
    const t = today();
    const person = (p) => ({
      id: p.id, name: nicks.get(p.id) || p.name, fullName: p.name, itemCount: p.item_count, photo: p.photo_at || null,
      occasions: occasionsFor(p, t),
    });
    return {
      me: { id: me.id, name: me.name, hasPin: me.hasPin, onboarded: me.onboarded, photo: people.find((p) => p.id === me.id)?.photo_at || null, profile: await profileOf(env, me.id) },
      today: t,
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
    const member = await env.DB.prepare("SELECT id, name, photo_at AS photo FROM members WHERE id = ?").bind(memberId).first();
    if (!member) fail(404, "List not found.");
    const own = memberId === me.id;
    const nicks = own ? new Map() : await nicknamesFor(env, me.id);
    member.fullName = member.name;
    member.name = nicks.get(member.id) || member.name;
    member.profile = await profileOf(env, member.id);

    if (own) {
      const { results } = await env.DB.prepare(
        "SELECT * FROM items WHERE owner_id = ? AND removed_at IS NULL ORDER BY draft, (priority = 'must') DESC, created_at",
      )
        .bind(me.id)
        .all();
      const { results: hidden } = await env.DB.prepare(
        "SELECT h.item_id, h.group_id FROM item_hidden h JOIN items i ON i.id = h.item_id WHERE i.owner_id = ?",
      )
        .bind(me.id)
        .all();
      const { results: cards } = await env.DB.prepare("SELECT brand FROM gift_cards WHERE member_id = ? ORDER BY created_at, brand")
        .bind(me.id)
        .all();
      return {
        member,
        own,
        items: results.map((r) => ({
          ...itemOut(r),
          hiddenFrom: hidden.filter((h) => h.item_id === r.id).map((h) => h.group_id),
        })),
        // Just the brands. Who is giving one never comes back to the owner.
        giftCards: cards.filter((c) => GIFT_CARD_NAMES.has(c.brand)).map((c) => ({ brand: c.brand })),
      };
    }

    const { results } = await env.DB.prepare(
      `SELECT i.*, c.buyer_id, b.name AS buyer_name, c.price_cents AS paid_cents, c.season AS claim_season
         FROM items i
         LEFT JOIN claims c ON c.item_id = i.id AND ${ACTIVE_CLAIM("claims", "item_id", "i.id")}
         LEFT JOIN members b ON b.id = c.buyer_id
        WHERE i.owner_id = ? AND (i.removed_at IS NULL OR c.item_id IS NOT NULL)
          AND (${ITEM_VISIBLE} OR c.buyer_id = ?)
        ORDER BY (c.item_id IS NOT NULL), (i.priority = 'must') DESC, i.created_at`,
    )
      .bind(today(), memberId, me.id, me.id)
      .all();
    // Suggestions shared by others, plus your own ideas (shared or not) for this person.
    const { results: ideas } = await env.DB.prepare(
      `${IDEA_SELECT}
        WHERE p.subject_id = ? AND (p.author_id = ? OR p.shared = 1 OR c.buyer_id = ?)
        ORDER BY (c.buyer_id IS NOT NULL), p.created_at`,
    )
      .bind(today(), memberId, me.id, me.id)
      .all();
    const visible = [];
    for (const r of ideas) if (await canSeeIdea(env, me.id, r)) visible.push(ideaOut(renameRow(r, nicks), me.id));
    return {
      member,
      own,
      giftCards: await giftCardsFor(env, memberId, me.id),
      items: results.map((r) => ({
        ...itemOut(r),
        removed: !!r.removed_at,
        claim: r.buyer_id
          ? { buyerId: r.buyer_id, buyerName: nicks.get(r.buyer_id) || r.buyer_name, mine: r.buyer_id === me.id, price_cents: r.paid_cents, occasion: r.claim_season }
          : null,
      })),
      suggestions: visible.filter((i) => !i.mine),
      myIdeas: visible.filter((i) => i.mine),
    };
  },

  // Add (no id) or edit (id) one of your own items. New items start in "Just me" (draft) until published.
  // "Must have" only applies to published items, so it is dropped on drafts.
  async "POST item/save"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const existing = b.id
      ? await env.DB.prepare("SELECT draft FROM items WHERE id = ? AND owner_id = ? AND removed_at IS NULL").bind(b.id, me.id).first()
      : null;
    if (b.id && !existing) fail(404, "Item not found.");
    const isDraft = existing ? !!existing.draft : true;
    const fields = [
      text(b.title, LIMITS.title, "Title", true),
      link(b.url),
      cents(b.price),
      text(b.notes, LIMITS.notes, "Notes"),
      !isDraft && b.priority === "must" ? "must" : null,
    ];
    const t = now();
    const image = fields[1] ? imageLink(b.image) : null;
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
        `UPDATE items SET ${IMAGE_SET}, title = ?4, url = ?2, price_cents = ?5, notes = ?6, priority = ?7, updated_at = ?3
          WHERE id = ?8 AND owner_id = ?9 AND removed_at IS NULL`,
      )
        .bind(image, fields[1], t, fields[0], fields[2], fields[3], fields[4], b.id, me.id)
        .run();
      if (!res.meta.changes) fail(404, "Item not found.");
      const rows = await hideRows(b.id)();
      // category absent (e.g. the Top pick toggle) leaves it as is.
      if (b.category !== undefined) rows.push(env.DB.prepare("UPDATE items SET category = ? WHERE id = ?").bind(category(b.category), b.id));
      if (rows.length) await env.DB.batch(rows);
      return { id: b.id };
    }
    const id = newId();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO items (id, owner_id, title, url, price_cents, notes, priority, created_at, updated_at, image_url, image_checked_at, category, draft) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
      ).bind(id, me.id, ...fields, t, t, image, image ? t : null, category(b.category)),
      ...(await hideRows(id)()),
    ]);
    return { id };
  },

  // Publish one of your "Just me" items to your wish list. One way: a published item never goes back to drafts.
  // created_at is reset so it sorts as a new wish on the list.
  async "POST item/publish"(req, env) {
    const me = await auth(req, env);
    const { id } = await body(req);
    const t = now();
    const res = await env.DB.prepare(
      "UPDATE items SET draft = 0, created_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND removed_at IS NULL AND draft = 1",
    )
      .bind(t, t, id, me.id)
      .run();
    if (!res.meta.changes) fail(404, "Item not found or already on your list.");
    return { ok: true };
  },

  // Remove one of your items. If someone already bought it, keep it for them (flagged "removed").
  async "POST item/remove"(req, env) {
    const me = await auth(req, env);
    const { id } = await body(req);
    const item = await env.DB.prepare("SELECT id FROM items WHERE id = ? AND owner_id = ? AND removed_at IS NULL")
      .bind(id, me.id)
      .first();
    if (!item) fail(404, "Item not found.");
    const claimed = await env.DB.prepare("SELECT 1 FROM claims WHERE item_id = ? AND season >= ?").bind(id, today()).first();
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
  // occasion: which of the owner's occasions it's for (YYYYMMDD; absent = keep it, or the soonest).
  async "POST claim"(req, env) {
    const me = await auth(req, env);
    const { itemId, on, price, occasion } = await body(req);
    const paid = cents(price);
    const item = await env.DB.prepare(`SELECT i.id, i.owner_id, i.removed_at, ${ITEM_VISIBLE} AS visible FROM items i WHERE i.id = ?`)
      .bind(me.id, itemId)
      .first();
    if (!item) fail(404, "Item not found.");
    if (item.owner_id === me.id) fail(400, "You can't mark your own items.");
    const existing = await env.DB.prepare("SELECT buyer_id, season FROM claims WHERE item_id = ? AND season >= ? ORDER BY season LIMIT 1")
      .bind(itemId, today()).first();
    // Hidden from all your shared families: only the person who already bought it can still change their mark.
    if (!item.visible && existing?.buyer_id !== me.id) fail(404, "Item not found.");
    if (on) {
      if (existing && existing.buyer_id !== me.id) fail(409, "Someone already marked this as purchased.");
      const s = await pickOccasion(env, item.owner_id, occasion, existing?.season);
      if (existing) {
        await env.DB.prepare("UPDATE claims SET price_cents = ?, season = ? WHERE item_id = ? AND season = ?")
          .bind(paid, s, itemId, existing.season).run();
      } else {
        if (item.removed_at) fail(400, "This item was removed from the list.");
        await env.DB.prepare("INSERT INTO claims (item_id, season, buyer_id, price_cents, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(itemId, s, me.id, paid, now())
          .run();
      }
    } else if (existing) {
      if (existing.buyer_id !== me.id) fail(403, "Only the person who marked it can undo that.");
      await env.DB.prepare("DELETE FROM claims WHERE item_id = ? AND season = ?").bind(itemId, existing.season).run();
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

  // Replace your gift card brands with this set (keys from public/giftcards.js). No other details.
  // Removing a brand someone is already giving keeps their gift (they see it flagged "removed").
  async "POST giftcards/save"(req, env) {
    const me = await auth(req, env);
    const { brands } = await body(req);
    if (!Array.isArray(brands)) fail(400, "Pick some gift cards.");
    const keys = [...new Set(brands.map(String))].filter((k) => GIFT_CARD_NAMES.has(k));
    if (keys.length > LIMITS.giftCards) fail(400, "That's more gift cards than we can show.");
    const t = now();
    const marks = keys.map(() => "?").join(", ");
    await env.DB.batch([
      keys.length
        ? env.DB.prepare(`DELETE FROM gift_cards WHERE member_id = ? AND brand NOT IN (${marks})`).bind(me.id, ...keys)
        : env.DB.prepare("DELETE FROM gift_cards WHERE member_id = ?").bind(me.id),
      // Keeps the original date for brands already there, so the order on the list stays put.
      ...keys.map((k) => env.DB.prepare("INSERT OR IGNORE INTO gift_cards (member_id, brand, created_at) VALUES (?, ?, ?)").bind(me.id, k, t)),
    ]);
    return { ok: true, brands: keys };
  },

  // Give (on: true) or stop giving a gift card to someone, for one of their occasions (occasion: YYYYMMDD
  // of their Christmas or birthday; absent = the soonest). amount: optional, what you're putting on it.
  // Marking again with a new amount updates it. Never limited: everyone can give the same brand.
  // Stopping with no occasion takes back all your upcoming gifts of that brand for them.
  async "POST giftcard/give"(req, env) {
    const me = await auth(req, env);
    const { memberId, brand, on, amount, occasion } = await body(req);
    const key = String(brand || "");
    if (!GIFT_CARD_NAMES.has(key)) fail(404, "Gift card not found.");
    if (!memberId || memberId === me.id) fail(400, "You can't give yourself a gift card.");
    if (!(await sharesGroup(env, me.id, memberId))) fail(404, "List not found.");
    const mineAt = (s) =>
      env.DB.prepare("SELECT 1 FROM gift_card_gifts WHERE member_id = ? AND brand = ? AND season = ? AND buyer_id = ?").bind(memberId, key, s, me.id).first();
    if (on) {
      const paid = cents(amount);
      const s = await pickOccasion(env, memberId, occasion);
      if (await mineAt(s)) {
        await env.DB.prepare("UPDATE gift_card_gifts SET amount_cents = ? WHERE member_id = ? AND brand = ? AND season = ? AND buyer_id = ?")
          .bind(paid, memberId, key, s, me.id)
          .run();
      } else {
        const listed = await env.DB.prepare("SELECT 1 FROM gift_cards WHERE member_id = ? AND brand = ?").bind(memberId, key).first();
        if (!listed) fail(400, "This gift card was removed from the list.");
        await env.DB.prepare(
          "INSERT INTO gift_card_gifts (member_id, brand, season, buyer_id, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
          .bind(memberId, key, s, me.id, paid, now())
          .run();
      }
    } else if (occasion !== undefined && occasion !== null && occasion !== "") {
      await env.DB.prepare("DELETE FROM gift_card_gifts WHERE member_id = ? AND brand = ? AND season = ? AND buyer_id = ?")
        .bind(memberId, key, Number(occasion), me.id)
        .run();
    } else {
      await env.DB.prepare("DELETE FROM gift_card_gifts WHERE member_id = ? AND brand = ? AND buyer_id = ? AND season >= ?")
        .bind(memberId, key, me.id, today())
        .run();
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
      .bind(today(), me.id, ...(subject ? [subject] : []))
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
    const image = fields[1] ? imageLink(b.image) : null;
    let id = b.id;
    if (id) {
      const res = await env.DB.prepare(
        `UPDATE private_ideas SET ${IMAGE_SET}, title = ?4, url = ?2, price_cents = ?5, note = ?6, shared = ?7, updated_at = ?3
          WHERE id = ?8 AND author_id = ?9`,
      )
        .bind(image, fields[1], t, fields[0], fields[2], fields[3], fields[4], id, me.id)
        .run();
      if (!res.meta.changes) fail(404, "Idea not found.");
    } else {
      if (!b.subjectId || b.subjectId === me.id || !(await sharesGroup(env, me.id, b.subjectId))) fail(400, "Pick who this idea is for.");
      id = newId();
      await env.DB.prepare(
        "INSERT INTO private_ideas (id, author_id, subject_id, title, url, price_cents, note, shared, created_at, updated_at, image_url, image_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, me.id, b.subjectId, ...fields, t, t, image, image ? t : null)
        .run();
    }
    // "I bought this" on your own idea is the same as marking it purchased.
    if (b.bought !== undefined) await setIdeaClaim(env, me, id, !!b.bought, b.paid, b.occasion);
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
    const { ideaId, on, price, occasion } = await body(req);
    await setIdeaClaim(env, me, ideaId, !!on, price, occasion);
    return { ok: true };
  },

  // Set (amount) or clear (empty amount) your budget for one person for one occasion
  // (occasion: YYYYMMDD of their Christmas or birthday; absent = the soonest).
  async "POST budget"(req, env) {
    const me = await auth(req, env);
    const { subjectId, amount, occasion } = await body(req);
    if (!subjectId || subjectId === me.id || !(await sharesGroup(env, me.id, subjectId))) fail(400, "Pick who this budget is for.");
    const s = await pickOccasion(env, subjectId, occasion);
    const value = cents(amount);
    if (value === null) {
      await env.DB.prepare("DELETE FROM budgets WHERE author_id = ? AND subject_id = ? AND season = ?").bind(me.id, subjectId, s).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO budgets (author_id, subject_id, season, amount_cents) VALUES (?, ?, ?, ?) ON CONFLICT (author_id, subject_id, season) DO UPDATE SET amount_cents = excluded.amount_cents",
      )
        .bind(me.id, subjectId, s, value)
        .run();
    }
    return { ok: true };
  },

  // Product photo for an item or idea saved before photos existed (or whose link changed). Anyone who
  // can see it may ask; the lookup runs once per link, and the result is shared with everyone.
  async "POST image"(req, env) {
    const me = await auth(req, env);
    const { kind, id } = await body(req);
    let row;
    if (kind === "item") {
      row = await env.DB.prepare(
        `SELECT i.id, i.url, i.image_url, i.image_checked_at, i.price_cents, i.price_checked_at FROM items i
           LEFT JOIN claims c ON c.item_id = i.id AND c.buyer_id = ?
          WHERE i.id = ? AND (i.owner_id = ? OR ${ITEM_VISIBLE} OR c.item_id IS NOT NULL)`,
      ).bind(me.id, id, me.id, me.id).first();
    } else if (kind === "idea") {
      const idea = await env.DB.prepare(`${IDEA_SELECT} WHERE p.id = ?`).bind(today(), id).first();
      if (idea && (await canSeeIdea(env, me.id, idea))) row = idea;
    }
    if (!row) fail(404, "Not found.");
    const needImage = !row.image_checked_at;
    const needPrice = row.price_cents == null && !row.price_checked_at;
    if (!row.url || (!needImage && !needPrice)) return { image: row.image_url || null, price_cents: row.price_cents ?? null };
    const preview = await previewLink(env, row.url).catch(() => ({}));
    const image = needImage ? preview.image || null : row.image_url || null;
    const price = needPrice && preview.price ? Math.round(preview.price * 100) : row.price_cents ?? null;
    const table = kind === "item" ? "items" : "private_ideas";
    // Only fills a price that is still empty, so an owner's own price always wins.
    await env.DB.prepare(
      `UPDATE ${table} SET image_url = ?1, image_checked_at = ?2, price_checked_at = ?2,
         price_cents = CASE WHEN price_cents IS NULL THEN ?3 ELSE price_cents END
        WHERE id = ?4 AND url IS ?5`,
    ).bind(image, now(), price, row.id, row.url).run();
    return { image, price_cents: price };
  },

  // Autofill: read a product link and return its name and price (nothing is saved).
  async "POST preview"(req, env) {
    await auth(req, env);
    const { url } = await body(req);
    return previewLink(env, url);
  },

  // Photo to suggestions: Gemini guesses what the item is and finds a store page for each. Nothing is stored.
  async "POST identify"(req, env) {
    await auth(req, env);
    if (!env.GEMINI_API_KEY) fail(500, "Photo search isn't set up (missing GEMINI_API_KEY).");
    const { image } = await body(req);
    const match = typeof image === "string" && image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) fail(400, "That photo didn't come through. Try again.");
    if (match[2].length > 4_000_000) fail(400, "That photo is too large. Try a smaller one.");
    const photo = [{ inline_data: { mime_type: match[1], data: match[2] } }];
    // Search grounding finds real store pages. If the model or key can't do it (including a search quota or a
    // daily limit), fall back to a plain guess, which still names the item and links a store search.
    // The only time it doesn't fall back is a per-minute limit it already waited out: a second call would hit it too.
    let result = await callGemini(env, IDENTIFY_PROMPT, photo, IDENTIFY_SCHEMA, 40000, undefined, [{ google_search: {} }]);
    const q = result.quota;
    const perMinute = result.status === 429 && q && !q.daily && !q.notInPlan && !q.search;
    if (result.error && !perMinute) result = await callGemini(env, IDENTIFY_PROMPT, photo, IDENTIFY_SCHEMA, 25000);
    if (result.error) return result.error;
    const grounded = await groundedUrls(result.grounding);
    const clean = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
    const dollars = (v) => (typeof v === "number" && v > 0 && v < 100_000 ? Math.round(v) : null);
    const picked = (result.data?.suggestions || []).filter((x) => clean(x?.title, 1)).slice(0, 4);
    const suggestions = await Promise.all(picked.map(async (x) => {
      const search = clean(x.search, 150) || clean(x.title, 150);
      const where = await bestLink({ ...x, search }, grounded);
      return {
        title: clean(x.title, LIMITS.title),
        detail: clean(x.detail, 160),
        search,
        price_low: dollars(x.price_low),
        price_high: dollars(x.price_high),
        ...where,
      };
    }));
    return { suggestions };
  },

  // Your private planner: per person, their upcoming occasions (Christmas, and their birthday if they
  // added one), each with your budget and what you bought for it (list items and ideas) with what you
  // paid, plus your open ideas. Only ever about other people, only ever for you.
  async "GET tracker"(req, env) {
    const me = await auth(req, env);
    const t = today();
    const [people, budgets, itemBuys, ideaBuys, ideas, cardGifts] = await Promise.all([
      env.DB.prepare(
        `SELECT DISTINCT m.id, m.name, m.photo_at, m.birthday, m.birth_year FROM group_members gm JOIN members m ON m.id = gm.member_id
          WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_id = ?) AND m.id != ?
          ORDER BY m.name COLLATE NOCASE`,
      ).bind(me.id, me.id).all(),
      env.DB.prepare("SELECT subject_id, season, amount_cents FROM budgets WHERE author_id = ? AND season >= ?").bind(me.id, t).all(),
      env.DB.prepare(
        `SELECT i.owner_id AS subject_id, i.id, i.title, i.url, i.price_cents AS list_cents, c.price_cents AS paid_cents, c.created_at, c.season
           FROM claims c JOIN items i ON i.id = c.item_id WHERE c.buyer_id = ? AND c.season >= ? ORDER BY c.created_at`,
      ).bind(me.id, t).all(),
      env.DB.prepare(
        `SELECT p.subject_id, p.id, p.title, p.url, p.price_cents AS list_cents, c.price_cents AS paid_cents, c.created_at, c.season,
                p.author_id, a.name AS author_name
           FROM idea_claims c JOIN private_ideas p ON p.id = c.idea_id JOIN members a ON a.id = p.author_id
          WHERE c.buyer_id = ? AND c.season >= ? ORDER BY c.created_at`,
      ).bind(me.id, t).all(),
      env.DB.prepare(`${IDEA_SELECT} WHERE p.author_id = ? AND c.buyer_id IS NULL ORDER BY p.updated_at DESC`).bind(t, me.id).all(),
      env.DB.prepare(
        "SELECT member_id AS subject_id, brand, season, amount_cents, created_at FROM gift_card_gifts WHERE buyer_id = ? AND season >= ? ORDER BY created_at",
      ).bind(me.id, t).all(),
    ]);
    const nicks = await nicknamesFor(env, me.id);
    const purchase = (kind) => (r) => ({
      kind,
      id: r.id,
      subject_id: r.subject_id,
      occasion: r.season,
      title: r.title,
      url: r.url,
      list_cents: r.list_cents,
      paid_cents: r.paid_cents,
      spent_cents: r.paid_cents ?? r.list_cents ?? 0,
      date: r.created_at,
      from: kind === "item" ? "Their list" : r.author_id === me.id ? "My idea" : `Suggested by ${nicks.get(r.author_id) || r.author_name}`,
    });
    const cardBuy = (r) => ({
      kind: "giftcard",
      id: r.brand,
      brand: r.brand,
      subject_id: r.subject_id,
      occasion: r.season,
      title: `${GIFT_CARD_NAMES.get(r.brand) || "Gift"} gift card`,
      url: null,
      list_cents: null,
      paid_cents: r.amount_cents,
      spent_cents: r.amount_cents ?? 0,
      date: r.created_at,
      from: "Gift card",
    });
    const purchases = [...itemBuys.results.map(purchase("item")), ...ideaBuys.results.map(purchase("idea")), ...cardGifts.results.map(cardBuy)]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return {
      today: t,
      people: people.results.map((p) => {
        const occasions = occasionsFor(p, t);
        const mine = (rows) => rows.filter((x) => x.subject_id === p.id);
        // A mark or budget filed under an old birthday date (they changed it) still shows until that date passes.
        for (const code of new Set([...mine(budgets.results).map((b) => b.season), ...mine(purchases).map((x) => x.occasion)])) {
          if (!occasions.some((o) => o.code === code)) {
            const xmas = code % 10000 === 1225;
            occasions.push({ code, date: isoOf(code), christmas: xmas, birthday: !xmas, turning: null });
          }
        }
        occasions.sort((a, b) => a.code - b.code);
        return {
          id: p.id,
          name: nicks.get(p.id) || p.name,
          fullName: p.name,
          photo: p.photo_at || null,
          birthday: bdayOf(p),
          occasions: occasions.map((o) => {
            const bought = mine(purchases).filter((x) => x.occasion === o.code);
            return {
              ...o,
              budget_cents: mine(budgets.results).find((b) => b.season === o.code)?.amount_cents ?? null,
              spent_cents: bought.reduce((sum, x) => sum + x.spent_cents, 0),
              purchases: bought,
            };
          }),
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

  // Change your name, PIN, photo and/or profile. pin: "1234" sets it, "" removes it, absent leaves it alone.
  // photo: a small JPEG data URL (the app resizes it to a square first), "" removes it, absent leaves it alone.
  // birthday: "MM-DD" or "" to clear. birthYear: optional, "" to clear. sizes: { shirt, pants, shoe, ring }. avoid: free text.
  // brands: favorite brand names (free text). Absent = unchanged.
  async "POST profile"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    if (b.name !== undefined) {
      const name = text(b.name, LIMITS.name, "Name", true);
      await env.DB.prepare("UPDATE members SET name = ? WHERE id = ?").bind(name, me.id).run();
    }
    if (b.birthday !== undefined || b.birthYear !== undefined) {
      const before = await env.DB.prepare("SELECT birthday, birth_year FROM members WHERE id = ?").bind(me.id).first();
      const birthday = b.birthday !== undefined ? birthdayValue(b.birthday) : before?.birthday || null;
      let year = b.birthYear !== undefined ? b.birthYear : before?.birth_year;
      year = birthday && year !== null && year !== undefined && year !== "" ? Number(year) : null;
      if (year !== null) {
        if (!Number.isInteger(year) || year < 1900 || year > Math.floor(today() / 10000)) fail(400, "That birth year doesn't look right.");
        if (birthday === "02-29" && !isLeap(year)) fail(400, `${year} didn't have a February 29.`);
      }
      const after = { birthday, birth_year: year };
      const oldBday = occasionsFor(before).find((o) => o.birthday && !o.christmas)?.code;
      const next = occasionsFor(after);
      const newCode = (next.find((o) => o.birthday) || next.find((o) => o.christmas)).code;
      const rows = [env.DB.prepare("UPDATE members SET birthday = ?, birth_year = ? WHERE id = ?").bind(birthday, year, me.id)];
      // Budgets and marks family filed for your upcoming birthday follow it to the new date (or to Christmas
      // if you removed it). You never see them; this just keeps their plans together.
      if (oldBday && oldBday !== newCode) {
        rows.push(
          env.DB.prepare("UPDATE OR IGNORE budgets SET season = ? WHERE subject_id = ? AND season = ?").bind(newCode, me.id, oldBday),
          // Someone who already had a budget for the new date keeps that one.
          env.DB.prepare("DELETE FROM budgets WHERE subject_id = ? AND season = ?").bind(me.id, oldBday),
          env.DB.prepare("UPDATE OR IGNORE claims SET season = ? WHERE season = ? AND item_id IN (SELECT id FROM items WHERE owner_id = ?)").bind(newCode, oldBday, me.id),
          env.DB.prepare("UPDATE OR IGNORE idea_claims SET season = ? WHERE season = ? AND idea_id IN (SELECT id FROM private_ideas WHERE subject_id = ?)").bind(newCode, oldBday, me.id),
          env.DB.prepare("UPDATE OR IGNORE gift_card_gifts SET season = ? WHERE member_id = ? AND season = ?").bind(newCode, me.id, oldBday),
        );
      }
      await env.DB.batch(rows);
    }
    if (b.sizes !== undefined) {
      const src = b.sizes && typeof b.sizes === "object" ? b.sizes : {};
      const sizes = Object.fromEntries(SIZE_KEYS.map((k) => [k, text(src[k], LIMITS.size, "Size") || ""]).filter(([, v]) => v));
      await env.DB.prepare("UPDATE members SET sizes = ? WHERE id = ?").bind(Object.keys(sizes).length ? JSON.stringify(sizes) : null, me.id).run();
    }
    if (b.avoid !== undefined) {
      await env.DB.prepare("UPDATE members SET avoid = ? WHERE id = ?").bind(text(b.avoid, LIMITS.avoid, "Dislikes and allergies"), me.id).run();
    }
    if (b.brands !== undefined) {
      const seen = new Set(), brands = [];
      for (const v of Array.isArray(b.brands) ? b.brands : []) {
        const name = text(typeof v === "string" ? v.replace(/\s+/g, " ") : "", LIMITS.brand, "Brand name");
        if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); brands.push(name); }
      }
      if (brands.length > LIMITS.brands) fail(400, `That's a lot of brands. Keep it to ${LIMITS.brands}.`);
      await env.DB.prepare("UPDATE members SET brands = ? WHERE id = ?").bind(brands.length ? JSON.stringify(brands) : null, me.id).run();
    }
    if (b.pin !== undefined) {
      const pin = pinValue(b.pin);
      await env.DB.prepare("UPDATE members SET pin_hash = ? WHERE id = ?")
        .bind(pin ? await hashPin(me.id, pin) : null, me.id)
        .run();
    }
    if (b.photo !== undefined) {
      const photo = b.photo ? String(b.photo) : null;
      if (photo && (photo.length > MAX_PHOTO || !PHOTO_RE.test(photo))) fail(400, "That photo didn't work. Try another one.");
      await env.DB.prepare("UPDATE members SET photo = ?, photo_at = ? WHERE id = ?").bind(photo, photo ? now() : null, me.id).run();
    }
    return { ok: true };
  },

  // Finished (or skipped) the welcome tour. Stored per person so it doesn't come back on a new phone.
  async "POST onboarded"(req, env) {
    const me = await auth(req, env);
    await env.DB.prepare("UPDATE members SET onboarded_at = ? WHERE id = ? AND onboarded_at IS NULL").bind(now(), me.id).run();
    return { ok: true };
  },

  // A profile photo. No sign-in needed (an <img> can't send the token); ids are random and photos aren't private.
  // The app adds the photo's version (?v=photo_at), so a changed photo is a new URL and this one can be cached for good.
  async "GET photo"(req, env, url) {
    const row = await env.DB.prepare("SELECT photo FROM members WHERE id = ?").bind(url.searchParams.get("m") || "").first();
    const m = row?.photo && PHOTO_RE.exec(row.photo);
    if (!m) return new Response("Not found", { status: 404 });
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { "content-type": `image/${m[1]}`, "cache-control": "public, max-age=31536000, immutable" } });
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
