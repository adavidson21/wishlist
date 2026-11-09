// Hints API: shared wish lists, "purchased" marks hidden from the list owner, and private gift ideas.
// Three layers: people, optional households (a few people who live or gift together), and circles (the
// `groups` table; the app used to call them families). A circle can include whole households and single people.
// Binding (wrangler.jsonc): DB (D1 database "wishlist"). Schema: migrations/0001_wishlist.sql.
//
// Sign-in is the honor system: a family join code plus picking your name, with an optional 4-digit PIN.
// Each signed-in device gets a random token (header X-Wishlist-Token) that maps to a member.
//
// Privacy rules enforced here:
//   - An item's owner never gets its claims (purchased marks), including how many were bought and group gifts.
//   - Ideas are private to their author unless shared as a suggestion. A shared suggestion is visible to
//     everyone in the family except the person it's for. The person it's for never gets it in any response.
//   - Budgets and the spending tracker are only returned to their author, except that a household shares
//     its budgets and purchases for people outside it (household_budgets, sharesBudget). Budgets and
//     purchases for people inside your own household stay yours alone.
//   - You only see lists of people who share a group (circle) with you. Households are synced into
//     group_members (direct = 0), so that one table still answers "do these two share a circle?".
//   - Nicknames ("Grandma" for "Jane Doe") are private to whoever set them. Every name in a response is
//     already swapped for the viewer's nickname; fullName is sent alongside where the UI needs it.
//   - Gift card gifts ("I'm giving one") are never returned to the person they're for. Any number of people
//     can give the same brand, so gift cards never show as taken.
//   - Chat about a person (chat_messages, one thread per circle) goes to everyone in that circle except the
//     person it's about. They never get a message, a count or an unread badge about their own thread.
//     Tags only point at wishes visible in that circle or at shared suggestions, so a tag can't leak a private idea.
//   - A person can be in several families. An item hidden from a family (item_hidden) is never shown through
//     that family: you see it only if you share some other family with the owner where it isn't hidden.
import { json, callGemini } from "./gemini.js";
import { LIMITS as ABUSE, hit, ipOf } from "./limits.js";
import { sendPush, vapidKeys, pushEndpointOk } from "./push.js";
import { STORES, STORE_KEYS, PROMPT_STORE_LIST, isBlocked, storeFor, isBrandHost, cleanBrandDomain } from "./stores.js";
// Sets globalThis.GIFT_CARDS. Shared with the app, so both sides use the same brand list.
import "../public/giftcards.js";

const BASE = "/api/";
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/;
const MAX_PHOTO = 120_000; // characters of data URL; the app sends about 10 to 20 KB
// A photo from the app (data URL), or null to remove it.
function photoValue(v) {
  const photo = v ? String(v) : null;
  if (photo && (photo.length > MAX_PHOTO || !PHOTO_RE.test(photo))) fail(400, "That photo didn't work. Try another one.");
  return photo;
}
const LIMITS = { chat: 500, tag: 40, tags: 30, bio: 100, stash: 80, color: 40, household: 40, loves: 200, nickname: 40, name: 40, lastName: 40, size: 30, avoid: 300, brand: 40, brands: 20, giftCards: 60, group: 60, title: 200, url: 2000, notes: 1000 };
// Wish categories. Must match CATS in public/index.html. NULL means "guess from the title" (done in the app).
const CATEGORIES = new Set(["beauty", "tech", "clothing", "shoes", "accessories", "home", "kitchen", "books", "toys", "outdoors", "treats", "experiences", "other"]);
const category = (v) => (typeof v === "string" && CATEGORIES.has(v) ? v : null);
// Progress stages for a gift you bought (NULL = ordered / on the way). Must match STAGES in public/index.html.
const PURCHASE_STAGES = new Set(["home", "wrapped", "given"]);
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

// A member row's birthday (members.birthday "MM-DD", no year: Hints never shows ages) as numbers, or null.
function bdayOf(m) {
  const x = typeof m?.birthday === "string" && m.birthday.match(/^(\d{2})-(\d{2})$/);
  return x ? { month: +x[1], day: +x[2] } : null;
}
// Upcoming occasions for a member row (birthday), soonest first.
// Each: { code, date, christmas, birthday }. A Dec 25 birthday is one occasion that's both.
function occasionsFor(m, now = today()) {
  const y = Math.floor(now / 10000);
  const xmas = dateCode(y, 12, 25) >= now ? dateCode(y, 12, 25) : dateCode(y + 1, 12, 25);
  const list = [{ code: xmas, christmas: true, birthday: false }];
  const b = bdayOf(m);
  if (b) {
    let code = birthdayCode(y, b.month, b.day);
    if (code < now) code = birthdayCode(y + 1, b.month, b.day);
    const same = list.find((o) => o.code === code);
    if (same) same.birthday = true;
    else list.push({ code, christmas: false, birthday: true });
  }
  return list.sort((a, b) => a.code - b.code).map((o) => ({ ...o, date: isoOf(o.code) }));
}

async function memberOccasions(env, memberId) {
  const m = await env.DB.prepare("SELECT birthday FROM members WHERE id = ?").bind(memberId).first();
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

// ---------- abuse limits (numbers in src/limits.js) ----------
// Counts one hit for `key` against each [max, windowSec]; 429 once any is over.
async function rateLimit(env, key, windows, message = "You're doing that a lot. Wait a bit and try again.") {
  for (const [max, win] of Array.isArray(windows[0]) ? windows : [windows]) {
    if ((await hit(env, key, win)) > max) fail(429, message);
  }
}
// Same, but answers true/false instead of failing (for background calls that should quietly do nothing).
async function underLimit(env, key, windows) {
  for (const [max, win] of Array.isArray(windows[0]) ? windows : [windows]) {
    if ((await hit(env, key, win)) > max) return false;
  }
  return true;
}
// A brand new person: per-IP and whole-app daily caps, so nobody can fill the database with fake people.
async function newMemberAllowed(env, request) {
  await rateLimit(env, `newmember:ip:${ipOf(request)}`, ABUSE.newMemberPerIp, "Too many new people from here today. Try again tomorrow.");
  if ((await hit(env, "newmember:all", 86400)) > ABUSE.newMembersPerDay) fail(429, "Hints isn't taking new people right now. Try again tomorrow.");
}
// Room for `adding` more people in a circle.
async function circleRoom(env, groupId, adding = 1) {
  if (adding <= 0) return;
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?").bind(groupId).first();
  if (n + adding > ABUSE.membersPerCircle) fail(409, `That circle is full (${ABUSE.membersPerCircle} people).`);
}
// Room for one more circle for this person.
async function circleSlot(env, memberId) {
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE member_id = ?").bind(memberId).first();
  if (n >= ABUSE.circlesPerMember) fail(409, `You're in ${n} circles, the most allowed. Leave one first.`);
}
// Checks a PIN. Every try counts (per person and per IP), so 4 digits can't be guessed: 8 tries per 15 minutes
// and 20 a day per person. Counting tries rather than misses means parallel guesses can't sneak past.
async function checkPin(env, request, member, pin) {
  const tooMany = "Too many PIN tries. Wait a while and try again.";
  await rateLimit(env, `pin:m:${member.id}`, ABUSE.pinTriesPerMember, tooMany);
  await rateLimit(env, `pin:ip:${ipOf(request)}`, ABUSE.pinTriesPerIp, tooMany);
  if (!pin) fail(403, "PIN required.");
  if ((await hashPin(member.id, String(pin))) !== member.pin_hash) fail(403, "Wrong PIN.");
}

function text(value, max, field, required = false) {
  const s = typeof value === "string" ? value.trim() : "";
  if (required && !s) fail(400, `${field} is required.`);
  if (s.length > max) fail(400, `${field} is too long (max ${max} characters).`);
  return s || null;
}

// Two people are the same name when first and last names both match (case-insensitive). The last name is optional
// (NULL matches an empty one). Use with `m` as the members alias and bind (first, last).
const SAME_NAME = "m.name = ? COLLATE NOCASE AND COALESCE(m.last_name, '') = COALESCE(?, '') COLLATE NOCASE";
// A real clash: same name AND same household (or both in none). Two Freddys are fine when one is in a household
// and the other isn't, or they're in different households; the app tells them apart by household. Bind
// (first, last, householdId).
const SAME_SLOT = `${SAME_NAME} AND COALESCE(m.household_id, '') = COALESCE(?, '')`;
const lastNameOf = (v) => text(v, LIMITS.lastName, "Last name");
const clashMsg = (first, last, where) => last
  ? `${first} ${last} is already in ${where}.`
  : `Someone named ${first} is already in ${where}. Add a last name to tell them apart.`;

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
  price_checked_at = CASE WHEN url IS ?2 THEN price_checked_at ELSE NULL END,
  price_est_cents = CASE WHEN url IS ?2 AND title IS ?4 THEN price_est_cents ELSE NULL END`;

// Save: the price syncs with the store only when it came from the link (the app sends priceAuto) and there's
// a link and a price to sync. Typing a price by hand turns syncing off.
const priceAuto = (b, fields) => (b.priceAuto && fields[1] && fields[2] != null ? 1 : 0);

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

// The JSON body as an object ({} if it isn't one). Over `max` characters is refused before parsing.
async function body(request, max = ABUSE.maxBody) {
  if (Number(request.headers.get("content-length") || 0) > max) fail(413, "That's too much to send at once.");
  let raw;
  try {
    raw = await request.text();
  } catch {
    return {};
  }
  if (raw.length > max) fail(413, "That's too much to send at once.");
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// A new device token. Each person keeps at most ABUSE.devicesPerMember; past that the least recently used is
// signed out, so signing in over and over can't pile up rows.
async function signIn(env, memberId) {
  const token = newToken();
  const t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO devices (token, member_id, created_at, last_seen) VALUES (?, ?, ?, ?)").bind(token, memberId, t, t),
    env.DB.prepare(
      "DELETE FROM devices WHERE member_id = ?1 AND token NOT IN (SELECT token FROM devices WHERE member_id = ?1 ORDER BY last_seen DESC, created_at DESC LIMIT ?2)",
    ).bind(memberId, ABUSE.devicesPerMember),
  ]);
  return token;
}

// Returns the signed-in member or throws 401.
async function auth(request, env) {
  const token = request.headers.get("x-wishlist-token");
  if (!token) fail(401, "Not signed in.");
  const me = await env.DB.prepare(
    "SELECT m.id, m.name, m.last_name, m.pin_hash, m.onboarded_at, m.pin_cleared_by, m.pin_cleared_at FROM devices d JOIN members m ON m.id = d.member_id WHERE d.token = ?",
  )
    .bind(token)
    .first();
  if (!me) fail(401, "Signed out. Join your circle again.");
  // Touch last_seen at most once a day to keep writes low.
  await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE token = ? AND last_seen < ?")
    .bind(now(), token, new Date(Date.now() - 86_400_000).toISOString())
    .run();
  return {
    id: me.id, name: me.name, lastName: me.last_name || null, hasPin: !!me.pin_hash, onboarded: !!me.onboarded_at, token,
    pinClearedBy: me.pin_cleared_by || null, pinClearedAt: me.pin_cleared_at || null,
  };
}

// Profile details shown to family on your list (migration 0008). Reads with SELECT * so a missing column
// just means an empty profile.
const SIZE_KEYS = ["shirt", "pants", "shoe", "ring"];
// Keys only; labels and colors live in public/index.html. Never rename a key (they're stored).
const GIFT_STYLES = ["surprise", "experiences", "practical", "homemade", "consumable", "books", "together", "giftcards",
  "list", "sentimental", "funny", "thrifted", "cash"];
const GIFT_STYLE_MAX = 5;
const FAV_COLORS = ["red", "pink", "orange", "yellow", "green", "teal", "blue", "navy", "purple", "brown", "black", "white", "gray", "gold", "silver"];
// Jewelry metals (migration 0028). Same rule: keys only, never rename one.
const METALS = ["gold", "silver", "rosegold", "gunmetal"];
// max: how many can be picked (gift style is up to GIFT_STYLE_MAX; colors are any of them).
function keysOut(v, allowed, max = 3) {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a.filter((k) => allowed.includes(k)).slice(0, max) : [];
  } catch {
    return [];
  }
}
function keysIn(v, allowed, max = 3) {
  const keys = [...new Set((Array.isArray(v) ? v : []).map(String))].filter((k) => allowed.includes(k));
  if (keys.length > max) fail(400, `Pick up to ${max}.`);
  return keys.length ? JSON.stringify(keys) : null;
}
function profileOut(row) {
  let sizes = {};
  try { sizes = JSON.parse(row?.sizes || "{}") || {}; } catch {}
  return {
    birthday: row?.birthday || null,
    sizes: Object.fromEntries(SIZE_KEYS.map((k) => [k, typeof sizes[k] === "string" ? sizes[k] : ""])),
    avoid: row?.avoid || "",
    brands: brandsOut(row?.brands),
    giftStyle: keysOut(row?.gift_style, GIFT_STYLES, GIFT_STYLE_MAX),
    colors: keysOut(row?.colors, FAV_COLORS, FAV_COLORS.length),
    // Colors they'd rather not get (migration 0030). Never also a favorite.
    colorsNo: keysOut(row?.colors_no, FAV_COLORS, FAV_COLORS.length).filter((k) => !keysOut(row?.colors, FAV_COLORS, FAV_COLORS.length).includes(k)),
    metals: (() => { try { const a = JSON.parse(row?.metals || "[]"); return Array.isArray(a) ? METALS.filter((k) => a.includes(k)) : []; } catch { return []; } })(),
    mixedMetals: !!row?.mixed_metals,
    loves: row?.loves || "",
    bio: row?.bio || "",
    // Before 0017, loves was one line of text. Until it's saved again, show it as tags.
    likes: row?.likes != null ? tagsOut(row.likes) : tagsOut(JSON.stringify(String(row?.loves || "").split(/[,;\n]+/))),
    dislikes: tagsOut(row?.dislikes),
    // "Already has" (migration 0032): so nobody buys a second of the same thing.
    owns: tagsOut(row?.owns),
    // When their sizes last changed (null: before migration 0032, or never set).
    sizesAt: row?.sizes_at || null,
    // A kid (migration 0033, set by whoever looks after them): Kid chip, Kids filter, size nudges.
    kid: !!row?.is_kid,
  };
}
function tagsOut(v) {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a.filter((x) => typeof x === "string").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, LIMITS.tags) : [];
  } catch {
    return [];
  }
}
// Loves or nopes from the app: trimmed, no repeats (any case), limited. Returns JSON or NULL.
function tagsIn(v, what) {
  const seen = new Set(), tags = [];
  for (const x of Array.isArray(v) ? v : []) {
    const t = text(typeof x === "string" ? x.replace(/\s+/g, " ") : "", LIMITS.tag, "That one");
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); tags.push(t); }
  }
  if (tags.length > LIMITS.tags) fail(400, `That's a lot of ${what.toLowerCase()}. Keep it to ${LIMITS.tags}.`);
  return tags.length ? JSON.stringify(tags) : null;
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

// SQL condition: item `i` is published (not in the owner's "Maybe" drafts) and visible to the viewer
// (bound once as ?) through at least one shared family that the owner hasn't hidden it from.
const ITEM_VISIBLE = `i.draft = 0 AND EXISTS (
  SELECT 1 FROM group_members x JOIN group_members y ON y.group_id = x.group_id
   WHERE x.member_id = ? AND y.member_id = i.owner_id
     AND NOT EXISTS (SELECT 1 FROM item_hidden h WHERE h.item_id = i.id AND h.group_id = x.group_id))`;

// ---------- chat about a person ----------
// One thread per circle and person. Messages older than this are swept and never returned.
const CHAT_KEEP_DAYS = 183;
const chatCutoff = () => new Date(Date.now() - CHAT_KEEP_DAYS * 86_400_000).toISOString();
const CHAT_EDIT_MS = 15 * 60_000;

// The viewer may read and write the chat about subject in group: both are in that circle and the viewer isn't the subject.
async function canSeeChat(env, viewerId, groupId, subjectId) {
  if (!groupId || !subjectId || viewerId === subjectId) return false;
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND member_id IN (?, ?)")
    .bind(String(groupId), viewerId, String(subjectId)).first();
  return n === 2;
}

// Message rows with what their tag points at. The tag's title is only filled in while it's still
// visible in this circle (a published wish not hidden from it, or a suggestion that's still shared).
const CHAT_SELECT = `SELECT c.*, a.name AS author_name,
    CASE WHEN i.id IS NOT NULL AND i.removed_at IS NULL AND i.draft = 0 AND i.owner_id = c.subject_id
          AND NOT EXISTS (SELECT 1 FROM item_hidden h WHERE h.item_id = i.id AND h.group_id = c.group_id) THEN i.title END AS item_title,
    CASE WHEN p.id IS NOT NULL AND p.shared = 1 AND p.subject_id = c.subject_id THEN p.title END AS idea_title
  FROM chat_messages c
  JOIN members a ON a.id = c.author_id
  LEFT JOIN items i ON i.id = c.item_id
  LEFT JOIN private_ideas p ON p.id = c.idea_id`;

function chatOut(r, meId, nicks) {
  const deleted = !!r.deleted_at;
  const tag = r.item_id ? { kind: "item", id: r.item_id, title: r.item_title || null }
    : r.idea_id ? { kind: "idea", id: r.idea_id, title: r.idea_title || null } : null;
  return {
    id: r.id,
    authorId: r.author_id,
    authorName: r.author_id === meId ? "You" : nicks.get(r.author_id) || r.author_name,
    mine: r.author_id === meId,
    body: deleted ? null : r.body,
    tag: deleted ? null : tag,
    at: r.created_at,
    edited: !!r.edited_at,
    deleted,
    canEdit: !deleted && r.author_id === meId && Date.now() - Date.parse(r.created_at) < CHAT_EDIT_MS,
  };
}

// Checks a tag for a new message: a wish of theirs visible in this circle, or a shared suggestion about them.
async function chatTag(env, groupId, subjectId, b) {
  if (b.itemId) {
    const ok = await env.DB.prepare(
      `SELECT 1 FROM items i WHERE i.id = ? AND i.owner_id = ? AND i.removed_at IS NULL AND i.draft = 0
         AND NOT EXISTS (SELECT 1 FROM item_hidden h WHERE h.item_id = i.id AND h.group_id = ?)`,
    ).bind(String(b.itemId), subjectId, groupId).first();
    if (!ok) fail(400, "That wish isn't on their list anymore.");
    return { item: String(b.itemId), idea: null };
  }
  if (b.ideaId) {
    const ok = await env.DB.prepare(
      `SELECT 1 FROM private_ideas p WHERE p.id = ? AND p.subject_id = ? AND p.shared = 1
         AND EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND member_id = p.author_id)`,
    ).bind(String(b.ideaId), subjectId, groupId).first();
    if (!ok) fail(400, "Only shared suggestions can be tagged.");
    return { item: null, idea: String(b.ideaId) };
  }
  return { item: null, idea: null };
}

// Unread counts for every thread the viewer can see: Map "groupId:subjectId" -> count. Never the viewer's own thread.
async function chatUnread(env, meId) {
  const { results } = await env.DB.prepare(
    `SELECT c.group_id, c.subject_id, COUNT(*) AS n
       FROM chat_messages c
       JOIN group_members me ON me.group_id = c.group_id AND me.member_id = ?1
       JOIN group_members s ON s.group_id = c.group_id AND s.member_id = c.subject_id
       LEFT JOIN chat_reads r ON r.member_id = ?1 AND r.group_id = c.group_id AND r.subject_id = c.subject_id
      WHERE c.subject_id != ?1 AND c.author_id != ?1 AND c.deleted_at IS NULL AND c.created_at > ?2
        AND c.created_at > COALESCE(r.last_read_at, '')
      GROUP BY c.group_id, c.subject_id`,
  ).bind(meId, chatCutoff()).all();
  return new Map(results.map((r) => [`${r.group_id}:${r.subject_id}`, r.n]));
}

async function markChatRead(env, meId, groupId, subjectId) {
  await env.DB.prepare(
    `INSERT INTO chat_reads (member_id, group_id, subject_id, last_read_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (member_id, group_id, subject_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
  ).bind(meId, groupId, subjectId, now()).run();
}

async function chatMessageFor(env, me, id) {
  const r = await env.DB.prepare(`${CHAT_SELECT} WHERE c.id = ?`).bind(String(id || "")).first();
  if (!r || !(await canSeeChat(env, me.id, r.group_id, r.subject_id))) fail(404, "Message not found.");
  return r;
}

// Messages tagged to each of subject's wishes and suggestions, in circles the viewer shares with them.
async function chatCounts(env, meId, subjectId) {
  if (meId === subjectId) return {};
  const { results } = await env.DB.prepare(
    `SELECT c.item_id, c.idea_id, COUNT(*) AS n FROM chat_messages c
       JOIN group_members x ON x.group_id = c.group_id AND x.member_id = ?1
       JOIN group_members y ON y.group_id = c.group_id AND y.member_id = ?2
      WHERE c.subject_id = ?2 AND c.deleted_at IS NULL AND c.created_at > ?3 AND (c.item_id IS NOT NULL OR c.idea_id IS NOT NULL)
      GROUP BY c.item_id, c.idea_id`,
  ).bind(meId, subjectId, chatCutoff()).all();
  const out = {};
  for (const r of results) out[r.item_id ? `item:${r.item_id}` : `idea:${r.idea_id}`] = r.n;
  return out;
}

async function myGroupIds(env, memberId) {
  const { results } = await env.DB.prepare("SELECT group_id FROM group_members WHERE member_id = ?").bind(memberId).all();
  return results.map((r) => r.group_id);
}

// Joining a circle yourself. If you were already in it through your household, you're now in it on your own too.
const JOIN_DIRECT =
  "INSERT INTO group_members (group_id, member_id, joined_at, direct) VALUES (?, ?, ?, 1) ON CONFLICT (group_id, member_id) DO UPDATE SET direct = 1";

// ---------- households ----------
// A household's display name: the name someone gave it, or its people's first names
// ("Alexis & Sam", "Jen, Mike & Ella", "Jen, Mike & 3 more"). `people` are display names (nicknames welcome).
function householdLabel(name, people) {
  if (name) return name;
  const first = people.map((p) => String(p || "").trim().split(/\s+/)[0]).filter(Boolean);
  if (!first.length) return "Household";
  if (first.length === 1) return `${first[0]}'s household`;
  if (first.length <= 3) return `${first.slice(0, -1).join(", ")} & ${first.at(-1)}`;
  return `${first.slice(0, 2).join(", ")} & ${first.length - 2} more`;
}

async function householdOf(env, memberId) {
  const row = await env.DB.prepare("SELECT household_id FROM members WHERE id = ?").bind(memberId).first();
  return row?.household_id || null;
}

// ---------- shared budgets (migration 0029) ----------
// A household gives together: when you're in a household and the person you're shopping for isn't in it, your
// whole household shares one budget for them and sees everything any of you bought for them. At Christmas the
// budget covers their whole household (if they have one); birthdays stay per person. Inside your own household,
// or when you have no household, budgets and purchases stay personal.
const isXmasCode = (code) => code % 10000 === 1225;
const sharesBudget = (myHh, subject) => !!myHh && subject.household_id !== myHh;
const budgetTarget = (subject, code) => (isXmasCode(code) && subject.household_id ? `h:${subject.household_id}` : `m:${subject.id}`);
// You plus everyone in your household who uses the app (the people whose purchases count toward shared budgets).
async function givers(env, me, myHh) {
  if (!myHh) return [{ id: me.id, name: me.name }];
  const { results } = await env.DB.prepare("SELECT id, name FROM members WHERE household_id = ? AND managed_by IS NULL").bind(myHh).all();
  return results.some((r) => r.id === me.id) ? results : [{ id: me.id, name: me.name }, ...results];
}

// Two people with the same name can share a circle only if they're in different households (see SAME_SLOT).
// Returns the circle name where `memberIds`, once in household `hh` (null = none), would clash, or null.
async function nameClash(env, groupIds, memberIds, hh) {
  for (const g of groupIds) {
    for (const m of memberIds) {
      const row = await env.DB.prepare(
        `SELECT g.name FROM groups g JOIN group_members gm ON gm.group_id = g.id JOIN members o ON o.id = gm.member_id
           JOIN members me ON me.id = ?
          WHERE g.id = ? AND o.id != me.id AND o.name = me.name COLLATE NOCASE
            AND COALESCE(o.last_name, '') = COALESCE(me.last_name, '') COLLATE NOCASE
            AND COALESCE(o.household_id, '') = COALESCE(?, '') LIMIT 1`,
      ).bind(m, g, hh || null).first();
      if (row) return row.name;
    }
  }
  return null;
}

// Takes someone out of a circle they were in only through their household. If it was their last circle,
// they stay in it on their own instead, so nobody ends up in no circle at all.
async function dropViaHousehold(env, memberId, groupId) {
  const row = await env.DB.prepare("SELECT direct FROM group_members WHERE group_id = ? AND member_id = ?").bind(groupId, memberId).first();
  if (!row || row.direct) return [];
  const others = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE member_id = ? AND group_id != ?").bind(memberId, groupId).first();
  if (!others.n) return [env.DB.prepare("UPDATE group_members SET direct = 1 WHERE group_id = ? AND member_id = ?").bind(groupId, memberId)];
  return [
    env.DB.prepare("DELETE FROM item_hidden WHERE group_id = ? AND item_id IN (SELECT id FROM items WHERE owner_id = ?)").bind(groupId, memberId),
    env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND member_id = ?").bind(groupId, memberId),
  ];
}

// Someone leaves their household (or is taken out of it): they drop out of the circles they were in only
// through it, and a household nobody is left in goes away.
async function leaveHousehold(env, memberId) {
  const hh = await householdOf(env, memberId);
  if (!hh) return;
  const { results } = await env.DB.prepare(
    "SELECT gm.group_id FROM group_members gm JOIN group_households gh ON gh.group_id = gm.group_id WHERE gm.member_id = ? AND gh.household_id = ? AND gm.direct = 0",
  ).bind(memberId, hh).all();
  const rows = [];
  // One at a time, so "last circle" is judged after the ones before it are gone.
  let left = (await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE member_id = ?").bind(memberId).first()).n;
  for (const r of results) {
    if (left > 1) {
      rows.push(
        env.DB.prepare("DELETE FROM item_hidden WHERE group_id = ? AND item_id IN (SELECT id FROM items WHERE owner_id = ?)").bind(r.group_id, memberId),
        env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND member_id = ?").bind(r.group_id, memberId),
      );
      left--;
    } else {
      rows.push(env.DB.prepare("UPDATE group_members SET direct = 1 WHERE group_id = ? AND member_id = ?").bind(r.group_id, memberId));
    }
  }
  rows.push(env.DB.prepare("UPDATE members SET household_id = NULL WHERE id = ?").bind(memberId));
  await env.DB.batch(rows);
  const still = await env.DB.prepare("SELECT 1 FROM members WHERE household_id = ? LIMIT 1").bind(hh).first();
  if (!still) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM group_households WHERE household_id = ?").bind(hh),
      env.DB.prepare("DELETE FROM households WHERE id = ?").bind(hh),
    ]);
  }
}

// A household you can organize: your own, or one with someone in a circle you're the admin of.
// Returns its id, or throws 404 (can't see it) / 403 (can see it, not yours to change).
async function manageableHousehold(env, meId, householdId) {
  const hh = String(householdId);
  if ((await householdOf(env, meId)) === hh) return hh;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT a.group_id FROM members m JOIN group_members a ON a.member_id = m.id JOIN group_members b ON b.group_id = a.group_id
      WHERE m.household_id = ? AND b.member_id = ?`,
  ).bind(hh, meId).all();
  if (!results.length) fail(404, "Household not found.");
  for (const r of results) if ((await adminOf(env, r.group_id)) === meId) return hh;
  fail(403, "Only the circle's admin can change someone else's household.");
}

// ---------- people someone looks after ----------
// A managed person (members.managed_by, migration 0023) doesn't use the app: a kid, or a grandparent. Whoever
// added them manages them, and so does anyone in the same household as them, and the admin of any circle
// they're in (so handing admin to someone else hands over the people who haven't joined yet too). Managers edit
// their list and profile, and still see purchased marks (the person themself never signs in, so there's no
// surprise to keep). Nobody can sign in as them until a manager hands the list over (managed/release) or they
// open their personal invite link (claim).
async function canManage(env, meId, memberId) {
  if (!memberId || memberId === meId) return false;
  const row = await env.DB.prepare("SELECT managed_by, household_id FROM members WHERE id = ?").bind(String(memberId)).first();
  if (!row?.managed_by) return false;
  if (row.managed_by === meId) return true;
  if (row.household_id && (await householdOf(env, meId)) === row.household_id) return true;
  const { results } = await env.DB.prepare(
    "SELECT a.group_id FROM group_members a JOIN group_members b ON b.group_id = a.group_id WHERE a.member_id = ? AND b.member_id = ?",
  ).bind(String(memberId), meId).all();
  for (const r of results) if ((await adminOf(env, r.group_id)) === meId) return true;
  return false;
}
const CLAIM_DAYS = 30;
async function sha256(textValue) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(textValue)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
// The person a personal invite link is for, or 404. Only people who haven't joined yet, before it expires.
async function claimFor(env, token) {
  const tk = String(token || "");
  if (!/^[A-Za-z0-9]{20,64}$/.test(tk)) fail(404, "That invite link didn't work.");
  const row = await env.DB.prepare(
    "SELECT id, name, managed_by, claim_expires FROM members WHERE claim_hash = ? AND managed_by IS NOT NULL",
  ).bind(await sha256(tk)).first();
  if (!row || !row.claim_expires || row.claim_expires < now()) fail(404, "That invite link didn't work. It may be old, or it was already used.");
  return row;
}
// Whose list or profile a write is for: yours, or (as: id) someone you look after.
async function ownerFor(env, me, as) {
  if (!as || as === me.id) return me.id;
  if (!(await canManage(env, me.id, as))) fail(403, "You can only change lists you look after.");
  return String(as);
}

// Each circle has one admin (groups.created_by): renames it, sets its photo, manages its households and can
// hand admin to someone else. If the admin is no longer in the circle (left, or dropped with a household),
// it passes to whoever has been in it longest. Returns the admin's member id, or null for an empty circle.
async function adminOf(env, groupId) {
  const row = await env.DB.prepare(
    `SELECT g.created_by AS admin, EXISTS (SELECT 1 FROM group_members WHERE group_id = g.id AND member_id = g.created_by) AS inIt
       FROM groups g WHERE g.id = ?`,
  ).bind(groupId).first();
  if (!row) return null;
  if (row.admin && row.inIt) return row.admin;
  // Never someone who doesn't use the app (a managed person).
  const next = await env.DB.prepare(
    `SELECT gm.member_id FROM group_members gm JOIN members m ON m.id = gm.member_id
      WHERE gm.group_id = ? AND m.managed_by IS NULL ORDER BY gm.direct DESC, gm.joined_at, gm.member_id LIMIT 1`,
  ).bind(groupId).first();
  const id = next?.member_id || null;
  if (id) await env.DB.prepare("UPDATE groups SET created_by = ? WHERE id = ?").bind(id, groupId).run();
  return id;
}

async function newUniqueJoinCode(env) {
  for (let i = 0; i < 5; i++) {
    const c = newJoinCode();
    if (!(await env.DB.prepare("SELECT 1 FROM groups WHERE join_code = ?").bind(c).first())) return c;
  }
  fail(500, "Couldn't make an invite code. Try again.");
}

async function groupByCode(env, code) {
  const c = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!c) fail(400, "Enter your invite code.");
  const group = await env.DB.prepare("SELECT id, name, join_code FROM groups WHERE join_code = ?").bind(c).first();
  if (!group) fail(404, "No circle found with that code. Check it and try again.");
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

// How many of a wish someone wants: 1 to 99, or 0 for "as many as you like".
function quantityValue(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 99) fail(400, "How many should be a number from 1 to 99.");
  return n;
}
const peopleList = (names) => (names.length < 2 ? names.join("") : names.length === 2 ? `${names[0]} and ${names[1]}`
  : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}` : `${names[0]}, ${names[1]} and ${names.length - 2} more`);
// A wish's purchases as someone other than its owner sees them (never sent to the owner).
// rows: its active claims, oldest first, with buyer_name. A wish can have several buyers (qty each) plus one
// group gift (chip_in rows, which together count as one).
// gift: { quantity, taken, left (null = no limit), buyers: [{ name, qty, mine }], group: { people, pledged_cents, occasion, startedBy } }.
// claim: your own mark, or (when nothing is left and there's no group gift to join) a summary, so "still
// available" is simply !claim.
function giftOut(item, rows, meId, nicks) {
  const name = (r) => nicks.get(r.buyer_id) || r.buyer_name;
  const quantity = item.quantity ?? 1;
  const solo = rows.filter((r) => !r.chip_in), group = rows.filter((r) => r.chip_in);
  const taken = solo.reduce((n, r) => n + (r.qty || 1), 0) + (group.length ? 1 : 0);
  const left = quantity === 0 ? null : Math.max(0, quantity - taken);
  const gift = {
    quantity, taken, left,
    buyers: solo.map((r) => ({ name: name(r), qty: r.qty || 1, mine: r.buyer_id === meId })),
    group: group.length ? {
      people: group.map((r) => ({ name: name(r), mine: r.buyer_id === meId })),
      pledged_cents: group.reduce((n, r) => n + (r.price_cents || 0), 0),
      occasion: group[0].season,
      startedBy: name(group[0]),
    } : null,
  };
  const mine = rows.find((r) => r.buyer_id === meId);
  let claim = null;
  if (mine) {
    claim = { buyerId: meId, buyerName: name(mine), mine: true, price_cents: mine.price_cents, occasion: mine.season, qty: mine.qty || 1, chipIn: !!mine.chip_in };
  } else if (left === 0 && rows.length && !group.length) {
    // A group gift is never "taken": anyone can still chip in. The app shows only Chip in once nothing else is left.
    claim = { buyerId: rows[0].buyer_id, buyerName: peopleList([...new Set(rows.map(name))]), mine: false, occasion: rows[0].season, many: new Set(rows.map((r) => r.buyer_id)).size > 1 };
  }
  return { gift, claim };
}

const itemOut = (r) => ({
  id: r.id,
  title: r.title,
  url: r.url,
  price_cents: r.price_cents,
  notes: r.notes,
  size: r.size || null,
  color: r.color || null,
  brand: r.brand || null,
  priority: r.priority,
  category: r.category || null,
  quantity: r.quantity ?? 1, // how many they want; 0 = as many as you like
  draft: !!r.draft,
  created_at: r.created_at,
  updated_at: r.updated_at,
  image_url: r.image_url || null,
  image_checked: !!r.image_checked_at,
  price_checked: !!r.price_checked_at,
  price_auto: !!r.price_auto,
  price_est: r.price_est_cents > 0 ? r.price_est_cents : null, // rough guess when there's no price ("~$40")
  est_checked: r.price_est_cents != null,
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
  price_auto: !!r.price_auto,
  price_est: r.price_est_cents > 0 ? r.price_est_cents : null,
  est_checked: r.price_est_cents != null,
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

// Size, color and brand on a wish: separate UPDATEs so a save without them (the Top pick toggle) leaves them alone.
function sizeColorRows(env, id, b) {
  const rows = [];
  if (b.brand !== undefined) rows.push(env.DB.prepare("UPDATE items SET brand = ? WHERE id = ?").bind(text(b.brand, LIMITS.brand, "Brand"), id));
  if (b.size !== undefined) rows.push(env.DB.prepare("UPDATE items SET size = ? WHERE id = ?").bind(text(b.size, LIMITS.size, "Size"), id));
  if (b.color !== undefined) rows.push(env.DB.prepare("UPDATE items SET color = ? WHERE id = ?").bind(text(b.color, LIMITS.color, "Color"), id));
  return rows;
}

// ---------- sizes and colors from a product link ----------
// Three places, best first: a Shopify store's public product JSON (/products/<handle>.js, which lists every
// option and variant), the page's JSON-LD (ProductGroup.hasVariant, or size/color on the Product), and the
// link's own query (?color=navy&size=M, ?variant=<id> on Shopify).
const SIZE_NAME = /^(size|sizes|taille|talla|shoe size|ring size|waist|length|inseam|fit)$/i;
const COLOR_NAME = /^(colou?r|colou?rs|colorway|shade|finish|pattern|style colou?r)$/i;
const SIZE_PARAM = /^(size|sz|selectedsize|size_code|sizecode|shoesize|dimension_size)$/i;
const COLOR_PARAM = /^(colou?r|colou?r_code|selectedcolou?r|colorway|shade|swatch)$/i;
const tidyOption = (v) => decode(String(v ?? "")).replace(/[_+]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
const uniq = (list) => [...new Map(list.map(tidyOption).filter(Boolean).map((v) => [v.toLowerCase(), v])).values()].slice(0, 40);
const niceParam = (v) => {
  const t = tidyOption(v);
  // Codes like "0001" or "BLK-123" aren't worth showing; words and sizes ("M", "8.5", "32x30") are.
  return /^[0-9]{3,}$/.test(t) || /^[A-Z0-9]{2,}-[A-Z0-9-]{2,}$/.test(t) ? "" : t.charAt(0).toUpperCase() + t.slice(1);
};

function optionsFromJsonLd(html) {
  const sizes = [], colors = [];
  let size = "", color = "";
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const queue = [data];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) { queue.push(...node); continue; }
      if (node["@graph"]) queue.push(node["@graph"]);
      const type = [].concat(node["@type"] || []).join(" ");
      if (!/Product/i.test(type)) continue;
      for (const v of [].concat(node.hasVariant || [])) {
        if (v?.size) sizes.push(typeof v.size === "object" ? v.size.name : v.size);
        if (v?.color) colors.push(v.color);
      }
      if (!/ProductGroup/i.test(type)) {
        if (node.size && !size) size = typeof node.size === "object" ? node.size.name : node.size;
        if (node.color && !color) color = node.color;
      }
    }
  }
  return { sizes: uniq(sizes), colors: uniq(colors), size: tidyOption(size), color: tidyOption(color) };
}

async function optionsFromShopify(url, html) {
  const handle = url.pathname.match(/\/products\/([^/?#]+)/)?.[1];
  if (!handle || (html && !/shopify/i.test(html))) return null;
  try {
    const res = await safeFetch(`${url.origin}/products/${handle}.js`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
    if (!res) return null;
    if (!res.ok || !/json/i.test(res.headers.get("content-type") || "")) { res.body?.cancel().catch(() => {}); return null; }
    const p = JSON.parse(await readCapped(res, 2_000_000));
    const opts = Array.isArray(p.options) ? p.options : [];
    const at = (re) => opts.findIndex((o) => re.test(String(typeof o === "object" ? o.name : o).trim()));
    const si = at(SIZE_NAME), ci = at(COLOR_NAME);
    const values = (i) => (i < 0 ? [] : uniq([].concat(opts[i]?.values || (p.variants || []).map((v) => v[`option${i + 1}`]))));
    const vid = url.searchParams.get("variant");
    const chosen = vid ? (p.variants || []).find((v) => String(v.id) === vid) : null;
    return {
      sizes: values(si), colors: values(ci),
      size: chosen && si >= 0 ? tidyOption(chosen[`option${si + 1}`]) : "",
      color: chosen && ci >= 0 ? tidyOption(chosen[`option${ci + 1}`]) : "",
      title: p.title ? decode(p.title) : null,
      brand: p.vendor ? decode(p.vendor) : null,
      price: chosen ? toPrice(chosen.price / 100) : toPrice((p.price ?? p.price_min) / 100),
      image: p.featured_image ? (String(p.featured_image).startsWith("//") ? `https:${p.featured_image}` : p.featured_image) : null,
    };
  } catch {
    return null;
  }
}

function optionsFromQuery(url) {
  let size = "", color = "";
  for (const [k, v] of url.searchParams) {
    if (!size && SIZE_PARAM.test(k)) size = niceParam(v);
    if (!color && COLOR_PARAM.test(k)) color = niceParam(v);
  }
  return { size, color };
}

// Everything we can tell about sizes and colors. Lists are what the store offers; size/color is what the link picked.
async function linkOptions(url, html) {
  const shop = await optionsFromShopify(url, html);
  const ld = html ? optionsFromJsonLd(html) : { sizes: [], colors: [], size: "", color: "" };
  const q = optionsFromQuery(url);
  return {
    shop,
    sizes: shop?.sizes.length ? shop.sizes : ld.sizes,
    colors: shop?.colors.length ? shop.colors : ld.colors,
    size: shop?.size || ld.size || q.size,
    color: shop?.color || ld.color || q.color,
  };
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
        const offers = [].concat(node.offers || [].concat(node.hasVariant || [])[0]?.offers || []); // ProductGroup: first variant's offer
        const offer = offers[0] || {};
        const price = toPrice(offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price ?? [].concat(offer.offers || [])[0]?.price);
        const img = [].concat(node.image || [])[0];
        const image = typeof img === "string" ? img : img?.url || img?.contentUrl || null;
        const avail = String(offer.availability || [].concat(offer.offers || [])[0]?.availability || "");
        const inStock = /InStock|LimitedAvailability|OnlineOnly|PreOrder|InStoreOnly/i.test(avail) ? true : /OutOfStock|SoldOut|Discontinued/i.test(avail) ? false : null;
        const b = [].concat(node.brand || node.manufacturer || [])[0];
        const brand = typeof b === "string" ? decode(b) : b?.name ? decode(b.name) : null;
        return { title: node.name ? decode(node.name) : null, price, image, inStock, brand };
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
  const parts = u.pathname.split("/").filter((p) => p && !/^(dp|p|product|products|ip|gp|item|itm|s)$/i.test(p) && !/^(?=.*\d)[a-z0-9]{8,}$/i.test(p));
  const slug = parts.sort((a, b) => b.length - a.length)[0];
  if (!slug || slug.length < 6 || /^\d+$/.test(slug)) return null;
  const words = decodeURIComponent(slug).replace(/\.\w+$/, "").replace(/[-_+]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Outbound fetches (store pages, product photos) only go to ordinary public websites: http(s) on the normal
// ports, a real domain name (no IP addresses, localhost or internal names) and no passwords in the link.
// Stops anyone using Hints as a proxy to poke at other servers.
function fetchable(u) {
  try {
    const x = u instanceof URL ? u : new URL(u);
    if (x.protocol !== "https:" && x.protocol !== "http:") return false;
    if (x.port && x.port !== "80" && x.port !== "443") return false;
    if (x.username || x.password) return false;
    const h = x.hostname.toLowerCase().replace(/\.$/, "");
    if (!h.includes(".") || h.startsWith("[") || /^[\d.]+$/.test(h)) return false;
    return !/(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|test|invalid|example|arpa)$/.test(h);
  } catch {
    return false;
  }
}

// Reads at most `max` characters of a response body, then stops downloading (a huge page can't eat the Worker's memory).
async function readCapped(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let out = "";
  try {
    while (out.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out.slice(0, max);
}

// fetch() that follows up to 5 redirects itself, checking every hop with fetchable(). Null if a hop isn't allowed.
async function safeFetch(url, init = {}, hops = 5) {
  let u = url instanceof URL ? url : new URL(url);
  for (let i = 0; i <= hops; i++) {
    if (!fetchable(u)) return null;
    const res = await fetch(u.toString(), { ...init, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return Object.defineProperty(res, "finalUrl", { value: u });
    res.body?.cancel().catch(() => {});
    u = new URL(loc, u);
  }
  return null;
}

// Fetches a page like a browser would. Returns the final URL after redirects and the HTML ("" if blocked or not HTML).
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
async function readPage(url, timeoutMs = 6000) {
  let html = "", finalUrl = url, status = 0;
  try {
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (res) {
      status = res.status;
      finalUrl = res.finalUrl;
      if (res.ok && /html/i.test(res.headers.get("content-type") || "")) html = await readCapped(res, 1_500_000);
      else res.body?.cancel().catch(() => {});
    }
  } catch {
    // Unreachable or slow: html stays empty.
  }
  return { html, finalUrl, status };
}

const BOT_PAGE = /robot check|robot or human|security check|security verification|are you a (robot|human)|captcha|access denied|just a moment|attention required|pardon our interruption|verify you are human|page not found|sorry! something went wrong|^amazon\.com$/i;

// Tracking junk that changes nothing about the product. Variant, size, color and sku parameters stay.
const TRACKING = /^(utm_\w+|gclid|gclsrc|gbraid|wbraid|dclid|fbclid|msclkid|mc_[ce]id|igshid|si|ref|ref_|refRID|_encoding|psc|pd_rd_\w+|pf_rd_\w+|content-id|crid|sprefix|qid|sr|keywords|dib|dib_tag|tag|linkCode|linkId|ascsubtag|th|smid|spLa|campaign|cmpid|cid|clickid|irclickid|irgwc|affid|afsrc|ranMID|ranEAID|ranSiteID|sharedid|share_id|epik|_branch_\w+|ga_\w+|clkid|athbdg|athcpid|athpgid|athznid|athieid|athena|adgrpid|hv\w+|lnk|intsrc|cm_\w+|srsltid|nci|cjevent|sscid|aff_\w+|source|src|from)$/i;
// Cleans a product link: drops tracking parameters and trims Amazon links to /dp/ASIN.
function cleanLink(u) {
  const out = new URL(u);
  out.hash = "";
  for (const k of [...out.searchParams.keys()]) if (TRACKING.test(k)) out.searchParams.delete(k);
  const asin = amazonAsin(out);
  if (asin) return `https://${out.hostname}/dp/${asin}`;
  return out.toString().replace(/\?$/, "");
}

// ---------- Amazon ----------
// Amazon blocks most requests from cloud servers, so its pages usually can't be read. These helpers get what we
// can without the page: the real product link behind a share link, its ASIN, and the main photo.
const isAmazon = (u) => /(^|\.)amazon\.[a-z.]+$/i.test(u.hostname);
const amazonAsin = (u) => (isAmazon(u) ? u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase() || null : null);
// Short links from the Amazon app's Share button (a.co/d/..., amzn.to/...).
const SHORT_LINK = /^(www\.)?(a\.co|amzn\.to|amzn\.eu|amzn\.asia|amzn\.com)$/i;
// Follows a share link's redirects until it reaches an Amazon product page. Returns the link unchanged if it
// isn't a share link or the redirects don't lead anywhere useful.
async function resolveShortLink(u) {
  if (!SHORT_LINK.test(u.hostname)) return u;
  let cur = u;
  try {
    for (let i = 0; i < 5 && fetchable(cur); i++) {
      const res = await fetch(cur.toString(), { redirect: "manual", signal: AbortSignal.timeout(4000), headers: { "user-agent": BROWSER_UA } });
      res.body?.cancel().catch(() => {});
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!loc) break;
      cur = new URL(loc, cur);
      if (amazonAsin(cur)) return cur;
    }
  } catch {}
  return amazonAsin(cur) ? cur : u;
}
// Amazon's main product photo by ASIN, from the image links Amazon gives affiliate widgets. Both return a tiny
// placeholder when there's no photo, so anything under 1 KB doesn't count.
async function amazonImage(asin) {
  const tries = [
    `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL500_&ID=AsinImage&MarketPlace=US&ServiceVersion=20070822&WS=1`,
    `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`,
  ];
  for (const u of tries) {
    try {
      const res = await safeFetch(u, { signal: AbortSignal.timeout(4000) });
      if (!res) continue;
      if (!res.ok || !/^image\//i.test(res.headers.get("content-type") || "")) { res.body?.cancel().catch(() => {}); continue; }
      const size = (await res.arrayBuffer()).byteLength;
      if (size >= 1024) return imageLink(res.finalUrl.toString());
    } catch {}
  }
  return null;
}

// Previews are cached for a day per link (Cloudflare's edge cache, nothing stored in D1), so the same link
// fills in the same way for everyone and a second Fill tap doesn't call Gemini again.
const PREVIEW_TTL = 86400;
const previewKey = (u) => new Request(`https://preview-cache.wishlist.invalid/${encodeURIComponent(u)}`);
async function cachedPreview(u) {
  try { const hit = await caches.default.match(previewKey(u)); return hit ? await hit.json() : null; } catch { return null; }
}
async function cachePreview(u, data) {
  try { await caches.default.put(previewKey(u), new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": `max-age=${PREVIEW_TTL}` } })); } catch {}
}

// Words in the link that describe the product ("stanley-quencher-tumbler" -> stanley, quencher, tumbler).
const STOP_WORDS = new Set("the and for with from your this that www com http https html htm product products item items shop store page dp ip p".split(" "));
function linkWords(u) {
  const words = decodeURIComponent(u.pathname).toLowerCase().split(/[^a-z0-9]+/);
  // Skip short words, filler, plain numbers and id-like tokens (letters mixed with digits, like B0BSHF7WHW).
  return new Set(words.filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/\d/.test(w)));
}
// A looked-up name must share a word with a descriptive link; links with no words (Amazon /dp/ASIN) pass.
function matchesLink(title, u) {
  const words = linkWords(u);
  if (words.size < 2) return true;
  const t = title.toLowerCase();
  return [...words].some((w) => t.includes(w) || (w.length > 4 && t.includes(w.slice(0, -1))));
}

// When a store blocks us (many big ones block requests from cloud servers), ask Gemini to look the link up
// through Google instead. It only reports what it found on that page or in search; the photo URL is checked
// to really be an image before we use it.
const LINK_PROMPT = `Someone pasted a product link into a gift wish list, and our server couldn't read the page.
Open the URL (use Google Search if you can't open it) and report the product on that exact page:
- found: false if you can't tell which product the link is for. Never invent or guess a product.
- title: the product's name as a shopper would say it, brand first when known, under 80 characters
- price: the current price in US dollars as a number, or null if you can't tell
- image: the URL of the main product photo exactly as it appears on the page or in search results (an image file,
  usually on the store's image server), or "" if you didn't see one. Never build or guess a URL.
- in_stock: true if that store currently shows it available to buy new, false if sold out or unavailable, null if unclear.
- sizes, colors: the size and color choices that page offers (as written there), or empty lists if none.
- size, color: the size and color this exact link has selected (for example from the URL), or "" if none.
- brand: the brand that makes the product (for example "Nike" or "Zara"), not the store selling it unless they're the same, or "" if unclear.`;
const LINK_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    title: { type: "string" },
    price: { type: "number", nullable: true },
    image: { type: "string" },
    in_stock: { type: "boolean", nullable: true },
    sizes: { type: "array", items: { type: "string" } },
    colors: { type: "array", items: { type: "string" } },
    size: { type: "string" },
    color: { type: "string" },
    brand: { type: "string" },
  },
  required: ["found", "title", "price", "image", "in_stock", "sizes", "colors", "size", "color", "brand"],
};
async function isImage(u) {
  try {
    const res = await safeFetch(u, { headers: { range: "bytes=0-2047" }, signal: AbortSignal.timeout(4000) });
    if (!res) return false;
    res.body?.cancel().catch(() => {});
    return res.ok && /^image\//i.test(res.headers.get("content-type") || "");
  } catch {
    return false;
  }
}
// hints: words that came with the link (share text, the link's own words). Only used to help find the product.
async function lookupLink(env, url, hints = []) {
  if (!env.GEMINI_API_KEY) return null;
  let msg = url;
  const asin = amazonAsin(new URL(url));
  if (asin) msg += `\nThis is an Amazon product. Its ASIN (Amazon's product ID) is ${asin}. Amazon pages often can't be opened, so search Google for "${asin}" and use the result for this exact ASIN.`;
  const extra = hints.filter(Boolean);
  if (extra.length) msg += `\nWords that came with the link (may help you find it, may be incomplete): ${extra.join(" / ")}`;
  const parts = [{ text: msg }];
  // URL context lets Gemini open the page itself; if this model doesn't offer it, search alone still helps.
  let r = await callGemini(env, LINK_PROMPT, parts, LINK_SCHEMA, 25000, undefined, [{ url_context: {} }, { google_search: {} }]);
  if (r.error && r.status === 400) r = await callGemini(env, LINK_PROMPT, parts, LINK_SCHEMA, 25000, undefined, [{ google_search: {} }]);
  const d = r.data;
  if (!d?.found || !d.title?.trim()) return null;
  let image = imageLink(d.image?.trim() || "");
  if (image && !(await isImage(image))) image = null;
  return { title: decode(d.title).slice(0, LIMITS.title), price: toPrice(d.price), image, inStock: typeof d.in_stock === "boolean" ? d.in_stock : null,
    sizes: uniq(Array.isArray(d.sizes) ? d.sizes : []), colors: uniq(Array.isArray(d.colors) ? d.colors : []), size: tidyOption(d.size), color: tidyOption(d.color), brand: tidyBrand(d.brand) };
}
// A brand name worth showing: trimmed, not a placeholder, short enough for the label.
function tidyBrand(v) {
  const t = decode(v).replace(/\s+/g, " ").trim();
  return !t || t.length > LIMITS.brand || /^(n\/?a|none|unknown|generic|unbranded|null|undefined)$/i.test(t) ? "" : t;
}

// ---------- live prices: what a linked store charges right now ----------
// Checked when someone opens a list, at most every 12 hours per link (shared through Cloudflare's edge cache,
// nothing stored in D1). Reads the store page; Gemini only for stores that block us. Misses are cached for
// 6 hours so a blocked store isn't looked up on every visit.
const LIVE_TTL = 12 * 3600, LIVE_MISS_TTL = 6 * 3600;
const liveKey = (u) => new Request(`https://live-price.wishlist.invalid/${encodeURIComponent(u)}`);
async function livePrice(env, rawUrl, { ai = true } = {}) {
  let clean;
  try { clean = cleanLink(await resolveShortLink(new URL(link(rawUrl)))); } catch { return null; }
  if (!clean) return null;
  try { const hit = await caches.default.match(liveKey(clean)); if (hit) return await hit.json(); } catch {}
  const url = new URL(clean);
  const site = url.hostname.replace(/^www\./, "");
  const { html } = await readPage(url, 5000);
  let price = null, inStock = null, via = "page";
  if (html && !BOT_PAGE.test(decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) || "")) {
    const ld = jsonLdProduct(html);
    price = ld.price
      ?? toPrice(meta(html, "product:price:amount", "og:price:amount", "price"))
      ?? toPrice(html.match(/class=["']a-offscreen["'][^>]*>\s*\$?([\d,.]+)/i)?.[1]); // Amazon
    inStock = ld.inStock ?? null;
    const availMeta = meta(html, "product:availability", "og:availability", "availability");
    if (inStock === null && availMeta) inStock = /out|sold|unavailable|discontinued/i.test(availMeta) ? false : /in ?stock|available|preorder/i.test(availMeta) ? true : null;
    if (inStock === null && /id=["']outOfStock["']|currently unavailable\./i.test(html)) inStock = false; // Amazon
  }
  if (price == null && inStock === null && ai) {
    const found = await lookupLink(env, clean).catch(() => null);
    if (found && matchesLink(found.title, url)) { price = found.price; inStock = found.inStock; via = "search"; }
  }
  const out = { price, inStock, site, via, checkedAt: now() };
  const hit = price != null || inStock !== null;
  try {
    await caches.default.put(liveKey(clean), new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": `max-age=${hit ? LIVE_TTL : LIVE_MISS_TTL}` } }));
  } catch {}
  console.log(`live ${site} -> ${via}${price != null ? ` $${price}` : ""}${inStock === false ? " out" : inStock ? " in" : ""}`);
  return out;
}

// ai: when the store blocks us, look it up with Gemini (only for the Fill button, not background lookups).
// hint: words shared along with the link ("Check out X! https://..."), used to help the lookup.
async function previewLink(env, rawUrl, { ai = false, hint = "" } = {}) {
  // Share links (a.co/d/...) become the real product link first, and the link's words are read before
  // cleaning trims Amazon links down to /dp/ASIN.
  const full = await resolveShortLink(new URL(link(rawUrl) || fail(400, "Paste a link first.")));
  const slugGuess = titleFromPath(full);
  const clean = cleanLink(full);
  const url = new URL(clean);
  const asin = amazonAsin(url);
  if (ai) {
    const hit = await cachedPreview(clean);
    if (hit && hit.price != null) return { ...hit, clean, cached: true };
  }
  const { html, finalUrl, status } = await readPage(url);

  let title = null, price = null, siteName = null, image = null, brand = null;
  if (html) {
    siteName = meta(html, "og:site_name");
    const ld = jsonLdProduct(html);
    brand = ld.brand || meta(html, "product:brand", "og:brand", "brand")
      || decode(html.match(/id=["']bylineInfo["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]).replace(/^(visit the|brand:)\s*/i, "").replace(/\s+store$/i, ""); // Amazon
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

  title = cleanTitle(title, finalUrl.hostname, siteName);
  // Last resort for the name: the link's words. The app says it's a guess.
  const guess = !title ? slugGuess || titleFromPath(finalUrl) || titleFromPath(url) : null;
  // Same rule as before the lookup existed: keep the page's photo whenever we have any name for it.
  let imageUrl = null;
  if (image && (title || guess)) {
    try { imageUrl = imageLink(new URL(image, finalUrl).toString()); } catch {}
  }
  const site = url.hostname.replace(/^www\./, "");
  const opts = await linkOptions(url, html);
  // A Shopify store's product JSON is often readable even when the page isn't.
  if (!title && opts.shop?.title) title = cleanTitle(opts.shop.title, url.hostname, siteName);
  if (!brand && opts.shop?.brand) brand = opts.shop.brand;
  if (price == null && opts.shop?.price != null) price = opts.shop.price;
  if (!imageUrl && opts.shop?.image && title) imageUrl = imageLink(opts.shop.image);
  let out = { url: finalUrl.toString(), title: title || guess, price, image: imageUrl, site, found: !!title, guessed: !title && !!guess,
    sizes: opts.sizes, colors: opts.colors, size: opts.size, color: opts.color, brand: tidyBrand(brand) };
  // The page gave us no name, photo or price (blocked, a bot check, or an empty shell): look it up. The page's own
  // details win; the lookup only fills what's missing.
  if (ai && (!title || !imageUrl || out.price == null)) {
    const found = await lookupLink(env, clean, [hint, slugGuess]).catch(() => null);
    if (found && (title || matchesLink(found.title, url))) {
      out = { ...out, title: title || found.title, price: price ?? found.price, image: imageUrl || found.image, found: true, guessed: false, via: "search",
        sizes: out.sizes.length ? out.sizes : found.sizes, colors: out.colors.length ? out.colors : found.colors,
        size: out.size || found.size, color: out.color || found.color, brand: out.brand || found.brand };
    }
  }
  // Amazon photo straight from its ASIN when neither the page nor the lookup gave one.
  if (asin && !out.image && (out.title || hint)) {
    out.image = await amazonImage(asin);
    if (out.image) out.imageVia = "asin";
  }
  console.log(`preview ${site} http=${status} page=${title ? "name" : html ? "noname" : "blocked"}${imageUrl ? "+photo" : ""} -> ${out.via || (out.guessed ? "guess" : "page")}${out.image ? " photo" : ""}${out.price != null ? " price" : ""}`);
  if (ai && out.found) await cachePreview(clean, out);
  return { ...out, clean };
}

// ---------- clean up a wish name (the ✨ button) ----------

const NAME_PROMPT = `You tidy up the name of one item on a gift wish list so family can tell at a glance what it is.
The input is JSON: name (often a long, messy store page title), link (the product URL, may be empty), brand (may be empty),
and avoid (names the person already saw and didn't want).
Return title: a short, clear name a shopper would say out loud, ideally 2 to 7 words and under 60 characters, brand first when known.
- Keep what matters to the gift: brand, product type, model or edition, and a defining variant (scent, flavor, edition).
- Drop store names, SEO keyword stuffing, marketing words ("Premium", "Best Seller", "2026 New"), pack and size details, emoji, and ALL CAPS.
- Use normal capitalization (brand names as the brand writes them).
- If name is empty, work it out from the words in the link. Never invent details that aren't in the input.
- If avoid has entries, return a noticeably different wording from all of them (shorter, or a different angle), still accurate.
- If the name is already short and clear and avoid is empty, return it unchanged.`;
const NAME_SCHEMA = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };

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

// ---------- details refresh: bring older wishes and ideas up to date ----------
// Bump DETAILS_V when a new field is filled from links, and every saved wish and idea gets re-read once more.
// Runs for the signed-in person's own wishes and ideas, a few per call (the app keeps calling while
// `remaining` > 0). Everything except the name and notes comes from the link: photo, brand, size and color fill
// only when empty, and the price is set from the store and synced from then on (price_auto), replacing a
// typed price. A link that gives nothing is still stamped, so it's tried only once.
const DETAILS_V = 1;
const REFRESH_BATCH = 3;
async function refreshRow(env, table, row) {
  const p = await previewLink(env, row.url, { ai: true }).catch(() => null);
  const ok = p && p.found && !p.guessed;
  const t = now();
  const price = ok && p.price != null ? Math.round(p.price * 100) : null;
  const image = ok ? p.image || null : null;
  const extra = table === "items"
    ? `, brand = COALESCE(NULLIF(brand, ''), ?7), size = COALESCE(NULLIF(size, ''), ?8), color = COALESCE(NULLIF(color, ''), ?9)`
    : "";
  const stmt = env.DB.prepare(
    `UPDATE ${table} SET details_v = ?1, image_url = COALESCE(image_url, ?2), image_checked_at = ?3, price_checked_at = ?3,
       price_cents = COALESCE(?4, price_cents), price_auto = CASE WHEN ?4 IS NOT NULL THEN 1 ELSE price_auto END${extra}
      WHERE id = ?5 AND url IS ?6`,
  );
  const args = [DETAILS_V, image, t, price, row.id, row.url];
  if (table === "items") args.push(ok ? p.brand || null : null, ok ? p.size || null : null, ok ? p.color || null : null);
  await stmt.bind(...args).run();
  return !!ok;
}

// ---------- price guess: "~$40" when the store price can't be read ----------
const ESTIMATE_PROMPT = `You estimate prices for a gift wish list when the store's price couldn't be read.
The input is JSON: name, brand, store (the website it's from, may be empty), size and color (may be empty).
Return price: what this exact product typically costs new in US dollars, as a number. Use what you know about the
brand and product line. Return null if you can't make a reasonable guess (too vague, or you don't know the product).`;
const ESTIMATE_SCHEMA = { type: "object", properties: { price: { type: "number", nullable: true } }, required: ["price"] };
async function estimatePrice(env, row) {
  if (!env.GEMINI_API_KEY || !row.title) return null;
  let store = "";
  try { store = row.url ? new URL(row.url).hostname.replace(/^www\./, "") : ""; } catch {}
  const input = { name: row.title, brand: row.brand || "", store, size: row.size || "", color: row.color || "" };
  const r = await callGemini(env, ESTIMATE_PROMPT, [{ text: JSON.stringify(input) }], ESTIMATE_SCHEMA, 12000);
  if (r.error) return undefined; // try again another time (rate limit, daily cap)
  const p = toPrice(r.data?.price);
  return p != null && p > 0 && p < 100000 ? Math.round(p * 100) : null;
}

// ---------- handlers ----------

// ---------- notifications ----------
// Web Push (src/push.js), turned on per device in Settings. Kinds, each with its own switch (members.notify,
// NULL = all on): new wishes (hourly digest), birthday and Christmas reminders, group gifts (when one starts),
// chat messages, and a once-a-year reminder about your own list. Everything follows the privacy rules: only people
// you share a circle with, only wishes you can see, never anything about your own gifts.
// Quiet hours: nothing is sent between 9 pm and 8 am New York time. Instant ones (group gifts, chat) wait in
// push_later and go out with the 8 am run; the wish digest just waits for the morning.
const NOTIFY_KINDS = ["wishes", "birthdays", "groupGifts", "chat", "reminders"];
function notifyPrefs(v) {
  let o = {};
  try { o = JSON.parse(v || "{}") || {}; } catch {}
  return Object.fromEntries(NOTIFY_KINDS.map((k) => [k, o[k] !== false]));
}
// A subscription (alias s) only counts while the device that turned it on is still signed in as that person.
// Signing out, being bumped by the device cap, or being removed ends it, so the next person on that phone never
// gets the last person's notifications.
const LIVE_SUB = "s.device_token IS NOT NULL AND EXISTS (SELECT 1 FROM devices d WHERE d.token = s.device_token AND d.member_id = s.member_id)";
const QUIET_FROM = 21, QUIET_UNTIL = 8;
// The hour in New York (0-23). PUSH_DEV_HOUR: local testing only (.dev.vars).
function nyHour(env) {
  if (env?.PUSH_DEV_HOUR !== undefined && env.PUSH_DEV_HOUR !== "") return +env.PUSH_DEV_HOUR;
  return +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date());
}
const isQuiet = (h) => h >= QUIET_FROM || h < QUIET_UNTIL;
// Today as YYYYMMDD for reminders. PUSH_DEV_TODAY: local testing only.
const pushToday = (env) => (env?.PUSH_DEV_TODAY ? +env.PUSH_DEV_TODAY : today());
// Most notifications one scheduled run sends. Every one is an outgoing request and the free plan allows 50 a run.
const RUN_BUDGET = 35;

// Everyone with at least one live device and this kind switched on.
async function pushRecipients(env, kind) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT m.id, m.name, m.notify, m.stale_ok_year FROM push_subs s JOIN members m ON m.id = s.member_id WHERE ${LIVE_SUB}`,
  ).all();
  return results.filter((m) => notifyPrefs(m.notify)[kind]);
}
// Sends to every live device of one person now. Gone subscriptions (404/410) are deleted. budget: { left } in
// scheduled runs. Returns how many devices got it.
async function deliver(env, memberId, payload, budget) {
  const { results } = await env.DB.prepare(`SELECT s.endpoint, s.p256dh, s.auth FROM push_subs s WHERE s.member_id = ? AND ${LIVE_SUB}`).bind(memberId).all();
  let sent = 0;
  for (const sub of results) {
    if (budget) budget.left--;
    const status = await sendPush(env, sub, payload).catch((err) => (console.error("push", err), 0));
    if (status === 404 || status === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(sub.endpoint).run();
    else if (status >= 200 && status < 300) sent++;
  }
  return sent;
}
// Instant notifications (group gifts, chat): sent now, or held until 8 am during quiet hours. Held ones keep only
// the newest per tag. anyTime: send even during quiet hours (the test button).
async function pushTo(env, memberId, payload, { anyTime = false } = {}) {
  if (!anyTime && isQuiet(nyHour(env))) {
    await env.DB.prepare(
      `INSERT INTO push_later (member_id, tag, payload, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (member_id, tag) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
    ).bind(memberId, String(payload.tag || "hints"), JSON.stringify(payload), now()).run();
    return 0;
  }
  return deliver(env, memberId, payload);
}
// The morning run: sends what quiet hours held. Anything older than a day is dropped (it's old news).
async function flushLater(env, budget) {
  await env.DB.prepare("DELETE FROM push_later WHERE created_at < ?").bind(new Date(Date.now() - 86_400_000).toISOString()).run();
  const { results } = await env.DB.prepare("SELECT member_id, tag, payload FROM push_later ORDER BY created_at LIMIT 100").all();
  let sent = 0;
  for (const row of results) {
    if (budget.left <= 0) break;
    await env.DB.prepare("DELETE FROM push_later WHERE member_id = ? AND tag = ?").bind(row.member_id, row.tag).run();
    sent += await deliver(env, row.member_id, JSON.parse(row.payload), budget);
  }
  return sent;
}
// A notification goes out once per key, even if a run is retried.
async function onceOnly(env, key) {
  const res = await env.DB.prepare("INSERT OR IGNORE INTO push_sent (key, sent_at) VALUES (?, ?)").bind(key, now()).run();
  return !!res.meta.changes;
}
const daysBetween = (a, b) => Math.round((Date.UTC(Math.floor(b / 10000), Math.floor(b / 100) % 100 - 1, b % 100) - Date.UTC(Math.floor(a / 10000), Math.floor(a / 100) % 100 - 1, a % 100)) / 86400000);
const weekdayOf = (code) => new Date(Date.UTC(Math.floor(code / 10000), Math.floor(code / 100) % 100 - 1, code % 100)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
// Has `buyerId` got anything for `subjectId` for this occasion yet (a wish, an idea, or a gift card)?
// Whether you (or, for someone outside your household, anyone in your household) got them something.
async function hasGiftFor(env, buyerId, subjectId, code) {
  const buyers = `(SELECT ?1 UNION SELECT b.id FROM members b JOIN members me ON me.id = ?1 JOIN members s ON s.id = ?2
     WHERE me.household_id IS NOT NULL AND b.household_id = me.household_id AND (s.household_id IS NULL OR s.household_id != me.household_id))`;
  const row = await env.DB.prepare(
    `SELECT 1 FROM claims c JOIN items i ON i.id = c.item_id WHERE c.buyer_id IN ${buyers} AND i.owner_id = ?2 AND c.season = ?3
     UNION ALL SELECT 1 FROM idea_claims c JOIN private_ideas p ON p.id = c.idea_id WHERE c.buyer_id IN ${buyers} AND p.subject_id = ?2 AND c.season = ?3
     UNION ALL SELECT 1 FROM gift_card_gifts WHERE buyer_id IN ${buyers} AND member_id = ?2 AND season = ?3 LIMIT 1`,
  ).bind(buyerId, subjectId, code).first();
  return !!row;
}
// People someone shares a circle with (not themself), with birthdays.
// People you're not doing gifts with (migration 0031): a Set of 'm:<id>' and 'h:<householdId>' targets.
async function skipsFor(env, meId) {
  const { results } = await env.DB.prepare("SELECT target FROM budget_skips WHERE author_id = ?").bind(meId).all();
  return new Set(results.map((r) => r.target));
}
const isSkipped = (skips, p) => skips.has(`m:${p.id}`) || (!!p.household_id && skips.has(`h:${p.household_id}`));

async function circlePeople(env, memberId) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT m.id, m.name, m.birthday, m.household_id FROM group_members gm JOIN members m ON m.id = gm.member_id
      WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_id = ?) AND m.id != ?`,
  ).bind(memberId, memberId).all();
  return results;
}
// How many wishes are new for a viewer across everyone, the same count as the "N new" badges (list_seen). Sent with
// the wish digest so the app icon's badge updates while the app is closed.
async function newWishTotal(env, viewerId) {
  const { results } = await env.DB.prepare(
    `SELECT ls.seen_count AS seen, (SELECT COUNT(*) FROM items i WHERE i.owner_id = ls.owner_id AND i.removed_at IS NULL AND ${ITEM_VISIBLE}) AS n
       FROM list_seen ls WHERE ls.viewer_id = ?`,
  ).bind(viewerId, viewerId).all();
  return results.reduce((t, r) => t + Math.max(0, r.n - r.seen), 0);
}

// Hourly outside quiet hours: "Sam added 2 wishes" for wishes published since the last digest, to everyone who can
// see them. Skips people you look after (you added those wishes yourself). The cursor only moves once everyone has
// been handled, and each person's digest has its own once-only key, so a run that stops early never loses or
// repeats one. Overnight wishes go out in the first morning run.
async function wishDigest(env, budget, hour) {
  const t = now();
  const cur = await env.DB.prepare("SELECT value FROM app_keys WHERE name = 'wishes_cursor'").first();
  const moveCursor = () => env.DB.prepare("INSERT INTO app_keys (name, value) VALUES ('wishes_cursor', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").bind(t).run();
  if (!cur) { await moveCursor(); return 0; } // First run: start counting from now.
  if (isQuiet(hour)) return 0;
  let sent = 0, finished = true;
  for (const r of await pushRecipients(env, "wishes")) {
    if (budget.left <= 0) { finished = false; break; }
    const { results } = await env.DB.prepare(
      `SELECT i.owner_id, m.name, COUNT(*) AS n FROM items i JOIN members m ON m.id = i.owner_id
        WHERE i.created_at > ? AND i.created_at <= ? AND i.removed_at IS NULL AND i.owner_id != ? AND ${ITEM_VISIBLE.replace("?", "?4")}
        GROUP BY i.owner_id, m.name ORDER BY MAX(i.created_at) DESC`,
    ).bind(cur.value, t, r.id, r.id).all();
    const rows = [];
    for (const x of results) if (!(await canManage(env, r.id, x.owner_id))) rows.push(x);
    if (!rows.length) continue;
    if (!(await onceOnly(env, `wishes:${r.id}:${cur.value}`))) continue;
    const nicks = await nicknamesFor(env, r.id);
    const nm = (x) => nicks.get(x.owner_id) || x.name;
    const wishes = (n) => (n === 1 ? "a wish" : `${n} wishes`);
    const badge = await newWishTotal(env, r.id).catch(() => undefined);
    const payload = rows.length === 1
      ? { title: `${nm(rows[0])} added ${wishes(rows[0].n)}`, body: `See what's new on ${nm(rows[0])}'s list.`, url: `/#person/${rows[0].owner_id}`, tag: `wishes:${rows[0].owner_id}`, badge }
      : { title: "New wishes", body: `${peopleList(rows.map((x) => `${nm(x)} added ${rows.length > 3 ? x.n : wishes(x.n)}`))}.`, url: "/#family", tag: "wishes", badge };
    sent += await deliver(env, r.id, payload, budget);
  }
  if (finished) await moveCursor();
  return sent;
}

// Once a day, from the 9 am run on (later runs pick up where a run that ran out of budget stopped):
// - birthdays 14 and 2 days out, to everyone who shares a circle with the birthday person (never to them),
// - Christmas on Dec 1 and Dec 18, only if you still need gifts,
// - from Nov 15, "Your list hasn't changed since last year" to the list's owner (once a year, not after Looks good).
async function reminders(env, budget) {
  const d = pushToday(env);
  const done = await env.DB.prepare("SELECT value FROM app_keys WHERE name = 'reminders_done'").first();
  if (done?.value === String(d) && !env.PUSH_DEV_REMIND) return 0;
  const xmas = occasionsFor({}, d).find((o) => o.christmas).code;
  const xmasIn = daysBetween(d, xmas);
  let sent = 0;
  for (const r of await pushRecipients(env, "birthdays")) {
    const skips = await skipsFor(env, r.id);
    const people = (await circlePeople(env, r.id)).filter((p) => !isSkipped(skips, p));
    const nicks = await nicknamesFor(env, r.id);
    const nm = (p) => nicks.get(p.id) || p.name;
    for (const p of people) {
      const bday = occasionsFor(p, d).find((o) => o.birthday);
      const n = bday ? daysBetween(d, bday.code) : -1;
      if (n !== 14 && n !== 2) continue;
      if (budget.left <= 0) return sent;
      if (!(await onceOnly(env, `bday:${r.id}:${p.id}:${bday.code}:${n}`))) continue;
      const has = await hasGiftFor(env, r.id, p.id, bday.code);
      sent += await deliver(env, r.id, {
        title: `${nm(p)}'s birthday is ${n === 14 ? "in 2 weeks" : weekdayOf(bday.code)}`,
        body: has ? "You've already got something lined up." : "You haven't picked a gift yet. Peek at their list?",
        url: `/#person/${p.id}`, tag: `bday:${p.id}`,
      }, budget);
    }
    if (xmasIn === 24 || xmasIn === 7) {
      const need = [];
      for (const p of people) if (!(await hasGiftFor(env, r.id, p.id, xmas))) need.push(nm(p));
      if (need.length) {
        if (budget.left <= 0) return sent;
        if (await onceOnly(env, `xmas:${r.id}:${xmas}:${xmasIn}`)) {
          sent += await deliver(env, r.id, {
            title: `Christmas is ${xmasIn === 7 ? "a week away" : `in ${xmasIn} days`}`,
            body: `Still need a gift for ${peopleList(need.sort())}.`, url: "/#budget", tag: "xmas",
          }, budget);
        }
      }
    }
  }
  const month = Math.floor(d / 100) % 100, year = Math.floor(d / 10000);
  if (month === 11 && d % 100 >= 15) {
    for (const r of await pushRecipients(env, "reminders")) {
      if (r.stale_ok_year === year) continue;
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n, MAX(MAX(created_at, updated_at)) AS latest FROM items WHERE owner_id = ? AND draft = 0 AND removed_at IS NULL",
      ).bind(r.id).first();
      if (!row?.n || String(row.latest || "") >= `${year}-01-01`) continue;
      if (budget.left <= 0) return sent;
      if (!(await onceOnly(env, `stale:${r.id}:${year}`))) continue;
      sent += await deliver(env, r.id, {
        title: "Your list hasn't changed since last year",
        body: "Everyone's starting to shop. Update a wish or drop a few new hints.", url: "/#mine", tag: "stale",
      }, budget);
    }
  }
  await env.DB.prepare("INSERT INTO app_keys (name, value) VALUES ('reminders_done', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").bind(String(d)).run();
  return sent;
}

// Someone started a group gift: tell everyone who can see that wish, except the person it's for and the starter.
// Once per wish, and a few a day per person, so starting and leaving over and over can't spam the circle.
async function groupGiftStarted(env, starter, item) {
  if (!(await underLimit(env, `groupalert:${starter.id}`, ABUSE.groupAlertsPerMemberDay))) return;
  if (!(await onceOnly(env, `group:${item.id}`))) return;
  for (const r of await pushRecipients(env, "groupGifts")) {
    if (r.id === starter.id || r.id === item.owner_id) continue;
    const seen = await env.DB.prepare(`SELECT 1 FROM items i WHERE i.id = ? AND i.removed_at IS NULL AND ${ITEM_VISIBLE}`).bind(item.id, r.id).first();
    if (!seen) continue;
    const nicks = await nicknamesFor(env, r.id);
    const owner = await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(item.owner_id).first();
    await pushTo(env, r.id, {
      title: `${nicks.get(starter.id) || starter.name} started a group gift for ${nicks.get(item.owner_id) || owner?.name || "someone"}`,
      body: `${item.title}. Want to chip in?`, url: `/#person/${item.owner_id}`, tag: `group:${item.id}`,
    });
  }
}

// A new chat message: tell everyone in that circle except the person it's about and the sender. One
// notification per unread stretch: someone who already has unread messages from the past week in that thread
// isn't told again until they open it. The notification for a thread replaces the last one (same tag).
async function chatPosted(env, author, groupId, subjectId, msg) {
  const { results: people } = await env.DB.prepare(
    `SELECT m.id, m.notify, r.last_read_at FROM group_members gm JOIN members m ON m.id = gm.member_id
       LEFT JOIN chat_reads r ON r.member_id = m.id AND r.group_id = gm.group_id AND r.subject_id = ?2
      WHERE gm.group_id = ?1 AND m.id NOT IN (?2, ?3) AND EXISTS (SELECT 1 FROM push_subs s WHERE s.member_id = m.id AND ${LIVE_SUB})`,
  ).bind(groupId, subjectId, author.id).all();
  for (const r of people) {
    if (!notifyPrefs(r.notify).chat) continue;
    const older = await env.DB.prepare(
      `SELECT 1 FROM chat_messages WHERE group_id = ? AND subject_id = ? AND author_id != ? AND id != ? AND deleted_at IS NULL
          AND created_at > ? AND created_at > ? LIMIT 1`,
    ).bind(groupId, subjectId, r.id, msg.id, r.last_read_at || "", new Date(Date.now() - 7 * 86_400_000).toISOString()).first();
    if (older) continue;
    const nicks = await nicknamesFor(env, r.id);
    const subject = await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(subjectId).first();
    const text = msg.body.length > 140 ? `${msg.body.slice(0, 137)}...` : msg.body;
    await pushTo(env, r.id, {
      title: `${nicks.get(author.id) || author.name} in the chat about ${nicks.get(subjectId) || subject?.name || "someone"}`,
      body: text, url: `/#person/${subjectId}/chat/${groupId}`, tag: `chat:${groupId}:${subjectId}`,
    });
  }
}

// The Cron Trigger (src/worker.js, hourly). Every run: drop subscriptions whose device is gone. Outside quiet
// hours: what quiet hours held (8 am), the wish digest, and from 9 am the daily reminders. One shared budget.
export async function runSchedule(env) {
  if (!env.DB) return;
  const hour = nyHour(env);
  const budget = { left: RUN_BUDGET };
  await env.DB.prepare(
    "DELETE FROM push_subs WHERE device_token IS NULL OR NOT EXISTS (SELECT 1 FROM devices d WHERE d.token = push_subs.device_token AND d.member_id = push_subs.member_id)",
  ).run().catch((err) => console.error("push sweep", err));
  if (hour === 3) {
    // Once a night: forget old digest keys (two days) and everything else after 400 days.
    await env.DB.prepare("DELETE FROM push_sent WHERE (key LIKE 'wishes:%' AND sent_at < ?) OR sent_at < ?")
      .bind(new Date(Date.now() - 2 * 86_400_000).toISOString(), new Date(Date.now() - 400 * 86_400_000).toISOString()).run().catch(() => {});
  }
  const later = isQuiet(hour) ? 0 : await flushLater(env, budget).catch((err) => (console.error("later", err), 0));
  const wishes = await wishDigest(env, budget, hour).catch((err) => (console.error("digest", err), 0));
  // PUSH_DEV_REMIND: local testing only (.dev.vars), runs reminders every time.
  const remind = (hour >= 9 && !isQuiet(hour)) || env.PUSH_DEV_REMIND === "1" ? await reminders(env, budget).catch((err) => (console.error("reminders", err), 0)) : 0;
  console.log(`schedule hour=${hour} later=${later} wishes=${wishes} reminders=${remind} budget_left=${budget.left}`);
}

// Signing in as someone who is looked after isn't allowed until a manager hands their list over.
async function notManaged(env, member) {
  if (!member.managed_by) return;
  const by = await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(member.managed_by).first();
  fail(409, `${member.name}'s list is looked after by ${by?.name || "someone in this circle"}. Ask them to tap "Let ${member.name} sign in" on ${member.name}'s list first.`);
}

const handlers = {
  // Step 1 of joining: show the family name and who is already in it.
  // `from` (optional) is the id of whoever sent the invite link; their name comes back as `inviter`.
  async "POST lookup"(req, env) {
    const b = await body(req);
    // Shared with /join/CODE previews (src/worker.js), so invite codes can't be guessed in bulk.
    await rateLimit(env, `lookup:ip:${ipOf(req)}`, ABUSE.lookupPerIp, "Too many tries. Wait a bit, then check the code and try again.");
    const group = await groupByCode(env, b.code);
    const info = b.from ? await inviteInfo(env, b.code, b.from) : null;
    const { results } = await env.DB.prepare(
      // People someone looks after can't be picked: they don't sign in until their list is handed over.
      "SELECT m.id, m.name, m.last_name, m.household_id, m.pin_hash, m.photo_at FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND m.managed_by IS NULL ORDER BY m.name COLLATE NOCASE",
    )
      .bind(group.id)
      .all();
    const adminId = await adminOf(env, group.id);
    // Only for first names that show up twice: a last initial ("Maria L."), or else their household's name.
    const firsts = results.map((m) => m.name.toLowerCase());
    const twice = (m) => firsts.indexOf(m.name.toLowerCase()) !== firsts.lastIndexOf(m.name.toLowerCase());
    const hhTag = new Map();
    for (const m of results) {
      if (!twice(m) || m.last_name || !m.household_id || hhTag.has(m.household_id)) continue;
      const h = await env.DB.prepare("SELECT name FROM households WHERE id = ?").bind(m.household_id).first();
      const { results: ppl } = await env.DB.prepare("SELECT name FROM members WHERE household_id = ? ORDER BY name COLLATE NOCASE").bind(m.household_id).all();
      hhTag.set(m.household_id, householdLabel(h?.name, ppl.map((p) => p.name)));
    }
    return {
      group: { name: group.name, admin: results.find((m) => m.id === adminId)?.name || null },
      inviter: info?.inviter || null,
      members: results.map((m) => ({
        id: m.id, name: m.name, hasPin: !!m.pin_hash, photo: m.photo_at || null,
        lastInitial: twice(m) && m.last_name ? m.last_name[0].toUpperCase() : null,
        household: twice(m) && !m.last_name ? hhTag.get(m.household_id) || null : null,
      })),
    };
  },

  // Step 2: sign in as an existing member (memberId, plus PIN if they set one) or add yourself (name).
  async "POST join"(req, env) {
    const b = await body(req);
    await rateLimit(env, `join:ip:${ipOf(req)}`, ABUSE.joinPerIp, "Too many sign-in tries. Wait a bit and try again.");
    const group = await groupByCode(env, b.code);
    let member;
    if (b.memberId) {
      member = await env.DB.prepare(
        "SELECT m.id, m.name, m.pin_hash, m.managed_by FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND m.id = ?",
      )
        .bind(group.id, b.memberId)
        .first();
      if (!member) fail(404, "That person isn't in this circle.");
      await notManaged(env, member);
    } else {
      const name = text(b.name, LIMITS.name, "First name", true);
      const lastName = lastNameOf(b.lastName);
      // "Yes, add me" always makes someone new. Typing a name that's taken never signs you in as them: returning
      // people tap their name instead, and a different person with the same name adds a last name.
      const taken = await env.DB.prepare(
        `SELECT 1 FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND ${SAME_NAME}`,
      )
        .bind(group.id, name, lastName)
        .first();
      if (taken) {
        fail(409, lastName
          ? `${name} ${lastName} is already in ${group.name}. If that's you, go back and tap your name.`
          : `Someone named ${name} is already in ${group.name}. If that's you, go back and tap your name. If not, add your last name.`);
      }
      const pin = pinValue(b.pin);
      await circleRoom(env, group.id);
      await newMemberAllowed(env, req);
      const id = newId();
      const t = now();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO members (id, name, last_name, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)").bind(
          id,
          name,
          lastName,
          pin ? await hashPin(id, pin) : null,
          t,
        ),
        env.DB.prepare(JOIN_DIRECT).bind(group.id, id, t),
      ]);
      return { token: await signIn(env, id) };
    }
    if (member.pin_hash) await checkPin(env, req, member, b.pin);
    return { token: await signIn(env, member.id) };
  },

  // Start a new family: creates the group, its join code, and you as its first member.
  async "POST start"(req, env) {
    const b = await body(req);
    const groupName = text(b.groupName, LIMITS.group, "Circle name", true);
    const name = text(b.name, LIMITS.name, "Your first name", true);
    const lastName = lastNameOf(b.lastName);
    const pin = pinValue(b.pin);
    await rateLimit(env, `start:ip:${ipOf(req)}`, ABUSE.startPerIp, "Too many new circles from here today. Try again tomorrow.");
    if ((await hit(env, "newcircle:all", 86400)) > ABUSE.newCirclesPerDay) fail(429, "Hints isn't taking new circles right now. Try again tomorrow.");
    await newMemberAllowed(env, req);
    const groupId = newId();
    const memberId = newId();
    const t = now();
    const code = await newUniqueJoinCode(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO groups (id, name, join_code, created_at) VALUES (?, ?, ?, ?)").bind(groupId, groupName, code, t),
      env.DB.prepare("INSERT INTO members (id, name, last_name, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        memberId,
        name,
        lastName,
        pin ? await hashPin(memberId, pin) : null,
        t,
      ),
      env.DB.prepare(JOIN_DIRECT).bind(groupId, memberId, t),
      env.DB.prepare("UPDATE groups SET created_by = ? WHERE id = ?").bind(memberId, groupId),
    ]);
    return { token: await signIn(env, memberId) };
  },

  // Who you are, your groups, and everyone in them with their item counts.
  async "GET me"(req, env) {
    const me = await auth(req, env);
    const { results: groups } = await env.DB.prepare(
      "SELECT g.id, g.name, g.join_code, g.created_by, g.photo_at FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.member_id = ? ORDER BY gm.joined_at",
    )
      .bind(me.id)
      .all();
    const { results: people } = await env.DB.prepare(
      `SELECT gm.group_id, m.id, m.name, m.last_name, m.photo_at, m.birthday, m.household_id, m.dislikes, m.owns, m.is_kid, m.managed_by, m.claim_expires, m.pin_hash IS NOT NULL AS has_pin,
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
    const myHh = await householdOf(env, me.id);
    const unread = await chatUnread(env, me.id);
    for (const g of groups) g.created_by = await adminOf(env, g.id);
    // People not on Hints yet in a circle you're the admin of: you can run their list too (canManage).
    const adminCircles = new Set(groups.filter((g) => g.created_by === me.id).map((g) => g.id));
    const adminManaged = new Set(people.filter((p) => p.managed_by && adminCircles.has(p.group_id)).map((p) => p.id));
    const manages = (p) => !!p.managed_by && p.id !== me.id
      && (p.managed_by === me.id || (!!p.household_id && p.household_id === myHh) || adminManaged.has(p.id));
    const tNow = now();
    const person = (p) => ({
      id: p.id, name: nicks.get(p.id) || p.name, fullName: p.name, lastName: p.last_name || null, itemCount: p.item_count, photo: p.photo_at || null,
      occasions: occasionsFor(p, t), householdId: p.household_id || null, hasPin: !!p.has_pin,
      // Their Nopes (shown on their page anyway), so the app can warn when an idea for them matches one.
      nopes: tagsOut(p.dislikes),
      // What they already have (warns on a matching idea), and whether they're a kid.
      owns: tagsOut(p.owns),
      kid: !!p.is_kid,
      // Someone who doesn't use the app: who added them, and whether you can run their list (canManage, same rule).
      managedBy: p.managed_by || null,
      canManage: manages(p),
      // Their personal invite link is out and not used yet (only for people you can manage).
      inviteSent: manages(p) && !!p.claim_expires && p.claim_expires > tNow,
      // Unread messages in the chat about them in this circle. Always 0 for yourself (chatUnread skips your thread).
      chatUnread: p.id === me.id ? 0 : unread.get(`${p.group_id}:${p.id}`) || 0,
    });
    // Households of anyone you can see. Labels use only people you can see (and your nicknames for them),
    // except your own household, which lists everyone in it.
    const hhIds = [...new Set(people.map((p) => p.household_id).filter(Boolean))];
    if (myHh && !hhIds.includes(myHh)) hhIds.push(myHh);
    const households = {};
    let myHousehold = null;
    if (hhIds.length) {
      const marks = hhIds.map(() => "?").join(",");
      const [{ results: hhRows }, { results: inCircles }, { results: myPeople }] = await Promise.all([
        env.DB.prepare(`SELECT id, name, photo_at FROM households WHERE id IN (${marks})`).bind(...hhIds).all(),
        env.DB.prepare(`SELECT group_id, household_id FROM group_households WHERE household_id IN (${marks})`).bind(...hhIds).all(),
        myHh
          ? env.DB.prepare("SELECT id, name, photo_at, pin_hash IS NOT NULL AS has_pin FROM members WHERE household_id = ? ORDER BY name COLLATE NOCASE").bind(myHh).all()
          : Promise.resolve({ results: [] }),
      ]);
      const seen = new Map();
      for (const p of people) if (p.household_id) seen.set(p.id, p);
      for (const h of hhRows) {
        const list = (h.id === myHh ? myPeople : [...seen.values()].filter((p) => p.household_id === h.id)).slice().sort(byName);
        households[h.id] = {
          id: h.id,
          name: h.name || null,
          photo: h.photo_at || null,
          label: householdLabel(h.name, list.map((p) => (p.id === me.id ? me.name : nicks.get(p.id) || p.name))),
          circles: inCircles.filter((c) => c.household_id === h.id).map((c) => c.group_id),
          // Who's in it (that you can see), you first, for the split household picture.
          memberIds: [...list.filter((p) => p.id === me.id), ...list.filter((p) => p.id !== me.id)].map((p) => p.id),
        };
        if (h.id === myHh) {
          myHousehold = {
            ...households[h.id],
            members: list.map((p) => ({ id: p.id, name: p.id === me.id ? me.name : nicks.get(p.id) || p.name, photo: p.photo_at || null, hasPin: !!p.has_pin })),
          };
        }
      }
    }
    let pinCleared = null;
    const prefsRow = await env.DB.prepare("SELECT notify, stale_ok_year FROM members WHERE id = ?").bind(me.id).first();
    const { results: seenRows } = await env.DB.prepare("SELECT owner_id, seen_count FROM list_seen WHERE viewer_id = ?").bind(me.id).all();
    if (me.pinClearedAt) {
      const by = me.pinClearedBy && (await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(me.pinClearedBy).first());
      pinCleared = { by: (by && (nicks.get(me.pinClearedBy) || by.name)) || "Someone", at: me.pinClearedAt };
    }
    return {
      me: {
        id: me.id, name: me.name, lastName: me.lastName, hasPin: me.hasPin, onboarded: me.onboarded, photo: people.find((p) => p.id === me.id)?.photo_at || null,
        // Someone cleared your forgotten PIN (see "POST pin/clear"). Shown once as a notice.
        pinCleared,
        profile: await profileOf(env, me.id), household: myHousehold,
        notify: notifyPrefs(prefsRow?.notify),
        // Year "Looks good" was tapped on the "hasn't changed since last year" card.
        staleOk: prefsRow?.stale_ok_year || null,
      },
      // How many wishes each person's list had when you last opened it, for the "N new" badges (any device).
      seen: Object.fromEntries(seenRows.map((r) => [r.owner_id, r.seen_count])),
      today: t,
      households,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        code: g.join_code,
        createdBy: g.created_by || null, // the circle's admin
        photo: g.photo_at || null,
        members: people.filter((p) => p.group_id === g.id).map(person).sort(byName),
      })),
    };
  },

  // ---------- chat about a person ----------
  // The thread about `member` in circle `group`. after: only messages newer than this (polling). Marks it read.
  async "GET chat"(req, env, url) {
    const me = await auth(req, env);
    const groupId = url.searchParams.get("group");
    const subjectId = url.searchParams.get("member");
    if (!(await canSeeChat(env, me.id, groupId, subjectId))) fail(404, "Chat not found.");
    const after = url.searchParams.get("after");
    // Polling also picks up edits and deletes since `after`.
    const { results } = await env.DB.prepare(
      after
        ? `${CHAT_SELECT} WHERE c.group_id = ?1 AND c.subject_id = ?2 AND c.created_at > ?3
             AND (c.created_at > ?4 OR c.edited_at > ?4 OR c.deleted_at > ?4) ORDER BY c.created_at LIMIT 200`
        : `${CHAT_SELECT} WHERE c.group_id = ?1 AND c.subject_id = ?2 AND c.created_at > ?3 ORDER BY c.created_at DESC LIMIT 200`,
    ).bind(...(after ? [groupId, subjectId, chatCutoff(), String(after)] : [groupId, subjectId, chatCutoff()])).all();
    const rows = after ? results : results.reverse();
    if (!after || rows.length) await markChatRead(env, me.id, groupId, subjectId);
    const nicks = await nicknamesFor(env, me.id);
    return { messages: rows.map((r) => chatOut(r, me.id, nicks)), admin: (await adminOf(env, groupId)) === me.id, now: now() };
  },

  // { group, member, body, itemId?, ideaId? }
  async "POST chat/send"(req, env, url, ctx) {
    const me = await auth(req, env);
    const b = await body(req);
    const groupId = String(b.group || "");
    const subjectId = String(b.member || "");
    if (!(await canSeeChat(env, me.id, groupId, subjectId))) fail(404, "Chat not found.");
    const msg = text(b.body, LIMITS.chat, "Message", true);
    const tag = await chatTag(env, groupId, subjectId, b);
    await rateLimit(env, `chat:m:${me.id}`, ABUSE.chatSendsPerMember);
    const id = newId();
    const t = now();
    await env.DB.prepare(
      "INSERT INTO chat_messages (id, group_id, subject_id, author_id, item_id, idea_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, groupId, subjectId, me.id, tag.item, tag.idea, msg, t).run();
    await markChatRead(env, me.id, groupId, subjectId);
    ctx?.waitUntil(chatPosted(env, me, groupId, subjectId, { id, body: msg }).catch((err) => console.error("chat push", err)));
    // Sweep messages past the keep window now and then.
    if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM chat_messages WHERE created_at < ?").bind(chatCutoff()).run().catch(() => {});
    const r = await env.DB.prepare(`${CHAT_SELECT} WHERE c.id = ?`).bind(id).first();
    return { message: chatOut(r, me.id, await nicknamesFor(env, me.id)) };
  },

  // Fix your own message within 15 minutes. { id, body }
  async "POST chat/edit"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const r = await chatMessageFor(env, me, b.id);
    if (r.author_id !== me.id || r.deleted_at) fail(404, "Message not found.");
    if (Date.now() - Date.parse(r.created_at) >= CHAT_EDIT_MS) fail(400, "Messages can only be edited for 15 minutes.");
    const msg = text(b.body, LIMITS.chat, "Message", true);
    await env.DB.prepare("UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?").bind(msg, now(), r.id).run();
    return { message: chatOut({ ...r, body: msg, edited_at: now() }, me.id, await nicknamesFor(env, me.id)) };
  },

  // Your own message, or any message if you're the circle's admin. Shows as "Message removed". { id }
  async "POST chat/delete"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const r = await chatMessageFor(env, me, b.id);
    if (r.author_id !== me.id && (await adminOf(env, r.group_id)) !== me.id) fail(403, "You can only remove your own messages.");
    await env.DB.prepare("UPDATE chat_messages SET deleted_at = ?, body = '' WHERE id = ? AND deleted_at IS NULL").bind(now(), r.id).run();
    return { ok: true };
  },

  // A member's wish list. Purchased marks are included only when you are not the owner.
  async "GET list"(req, env, url) {
    const me = await auth(req, env);
    const memberId = url.searchParams.get("member") || me.id;
    if (!(await sharesGroup(env, me.id, memberId))) fail(404, "List not found.");
    const member = await env.DB.prepare("SELECT id, name, last_name, photo_at AS photo FROM members WHERE id = ?").bind(memberId).first();
    if (!member) fail(404, "List not found.");
    member.lastName = member.last_name || null;
    delete member.last_name;
    const own = memberId === me.id;
    const manage = !own && (await canManage(env, me.id, memberId));
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

    const t = today();
    // A removed wish only stays while someone still has it marked; a hidden one only for its buyers.
    const { results } = await env.DB.prepare(
      `SELECT i.* FROM items i
        WHERE i.owner_id = ?
          AND (i.removed_at IS NULL OR EXISTS (SELECT 1 FROM claims c WHERE c.item_id = i.id AND c.season >= ?))
          AND (${ITEM_VISIBLE} OR EXISTS (SELECT 1 FROM claims c WHERE c.item_id = i.id AND c.season >= ? AND c.buyer_id = ?))
        ORDER BY (i.priority = 'must') DESC, i.created_at`,
    )
      .bind(memberId, t, me.id, t, me.id)
      .all();
    const { results: marks } = await env.DB.prepare(
      `SELECT c.item_id, c.season, c.buyer_id, c.qty, c.chip_in, c.price_cents, m.name AS buyer_name
         FROM claims c JOIN items i ON i.id = c.item_id JOIN members m ON m.id = c.buyer_id
        WHERE i.owner_id = ? AND c.season >= ? ORDER BY c.created_at, c.buyer_id`,
    ).bind(memberId, t).all();
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
      canManage: manage,
      giftCards: await giftCardsFor(env, memberId, me.id),
      items: results.map((r) => ({
        ...itemOut(r),
        removed: !!r.removed_at,
        ...giftOut(r, marks.filter((c) => c.item_id === r.id), me.id, nicks),
      })),
      suggestions: visible.filter((i) => !i.mine),
      myIdeas: visible.filter((i) => i.mine),
      // Messages tagged to each wish or suggestion, across the circles you share with them ("item:<id>" -> count).
      // Only here, on someone else's list: the owner's own list never gets this.
      chatCounts: await chatCounts(env, me.id, memberId),
    };
  },

  // Add (no id) or edit (id) one of your own items. size and color: free text, absent = unchanged. New items start in "Maybe" (draft) until published.
  // "Must have" only applies to published items, so it is dropped on drafts.
  // as: someone you look after (their wishes skip Maybe and go straight on their list).
  async "POST item/save"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const owner = await ownerFor(env, me, b.as);
    const forOther = owner !== me.id;
    const existing = b.id
      ? await env.DB.prepare("SELECT draft FROM items WHERE id = ? AND owner_id = ? AND removed_at IS NULL").bind(b.id, owner).first()
      : null;
    if (b.id && !existing) fail(404, "Item not found.");
    const isDraft = existing ? !!existing.draft : !forOther;
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
      if (!Array.isArray(b.hiddenFrom) || forOther) return [];
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
        .bind(image, fields[1], t, fields[0], fields[2], fields[3], fields[4], b.id, owner)
        .run();
      if (!res.meta.changes) fail(404, "Item not found.");
      const rows = await hideRows(b.id)();
      rows.push(...sizeColorRows(env, b.id, b));
      // category absent (e.g. the Top pick toggle) leaves it as is.
      // A full save from the wish form also counts as reviewed, so the details refresh leaves it alone.
      if (b.category !== undefined) rows.push(env.DB.prepare("UPDATE items SET category = ?, details_v = ? WHERE id = ?").bind(category(b.category), DETAILS_V, b.id));
      rows.push(env.DB.prepare("UPDATE items SET price_auto = ? WHERE id = ?").bind(priceAuto(b, fields), b.id));
      if (b.quantity !== undefined) rows.push(env.DB.prepare("UPDATE items SET quantity = ? WHERE id = ?").bind(quantityValue(b.quantity), b.id));
      if (rows.length) await env.DB.batch(rows);
      return { id: b.id };
    }
    const { n: itemCount } = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE owner_id = ? AND removed_at IS NULL").bind(owner).first();
    if (itemCount >= ABUSE.itemsPerMember) fail(409, `That list is full (${ABUSE.itemsPerMember} wishes). Remove a few to add more.`);
    const id = newId();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO items (id, owner_id, title, url, price_cents, notes, priority, created_at, updated_at, image_url, image_checked_at, category, draft, details_v) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${DETAILS_V})`,
      ).bind(id, owner, ...fields, t, t, image, image ? t : null, category(b.category), isDraft ? 1 : 0),
      env.DB.prepare("UPDATE items SET price_auto = ? WHERE id = ?").bind(priceAuto(b, fields), id),
      env.DB.prepare("UPDATE items SET quantity = ? WHERE id = ?").bind(b.quantity === undefined ? 1 : quantityValue(b.quantity), id),
      ...(await hideRows(id)()),
      ...sizeColorRows(env, id, b),
    ]);
    return { id };
  },

  // Publish one of your "Maybe" items to your wish list. One way: a published item never goes back to drafts.
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
    const { id, as } = await body(req);
    const owner = await ownerFor(env, me, as);
    const item = await env.DB.prepare("SELECT id FROM items WHERE id = ? AND owner_id = ? AND removed_at IS NULL")
      .bind(id, owner)
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

  // Mark (on: true) or unmark someone else's item as purchased. Only the buyer can unmark their own mark.
  // A wish can have several buyers, up to items.quantity (0 = no limit), plus one group gift.
  // price: what you paid, or your share of a group gift (optional). qty: how many you're getting (default 1).
  // chipIn: true starts the group gift (needs one left) or joins it (same occasion as the group).
  // occasion: which of the owner's occasions it's for (YYYYMMDD; absent = keep it, or the soonest).
  // Returns started: true when this started a new group gift.
  async "POST claim"(req, env, url, ctx) {
    const me = await auth(req, env);
    const { itemId, on, price, occasion, qty, chipIn } = await body(req);
    const paid = cents(price);
    const item = await env.DB.prepare(`SELECT i.id, i.owner_id, i.title, i.removed_at, i.quantity, ${ITEM_VISIBLE} AS visible FROM items i WHERE i.id = ?`)
      .bind(me.id, itemId)
      .first();
    if (!item) fail(404, "Item not found.");
    if (item.owner_id === me.id) fail(400, "You can't mark your own items.");
    const t = today();
    const { results: rows } = await env.DB.prepare("SELECT buyer_id, season, qty, chip_in FROM claims WHERE item_id = ? AND season >= ? ORDER BY created_at, buyer_id")
      .bind(itemId, t).all();
    const existing = rows.find((r) => r.buyer_id === me.id);
    // Hidden from all your shared families: only someone who already bought it can still change their mark.
    if (!item.visible && !existing) fail(404, "Item not found.");
    if (on) {
      const others = rows.filter((r) => r.buyer_id !== me.id);
      const groupOthers = others.filter((r) => r.chip_in);
      const usedByOthers = others.filter((r) => !r.chip_in).reduce((n, r) => n + (r.qty || 1), 0) + (groupOthers.length ? 1 : 0);
      const quantity = item.quantity ?? 1;
      const wantChip = chipIn === undefined ? !!existing?.chip_in : !!chipIn;
      let n = 1;
      if (!wantChip) {
        n = qty === undefined || qty === null || qty === "" ? (existing && !existing.chip_in ? existing.qty || 1 : 1) : Number(qty);
        if (!Number.isInteger(n) || n < 1 || n > 99) fail(400, "How many should be a number from 1 to 99.");
      }
      const need = wantChip ? (groupOthers.length ? 0 : 1) : n;
      if (quantity !== 0 && usedByOthers + need > quantity) {
        const left = Math.max(0, quantity - usedByOthers);
        fail(409, left ? `Only ${left} left to get.` : "Someone already marked this as purchased.");
      }
      if (!existing && item.removed_at) fail(400, "This item was removed from the list.");
      // Everyone in a group gift goes with the occasion it was started for.
      const s = wantChip && groupOthers.length ? groupOthers[0].season : await pickOccasion(env, item.owner_id, occasion, existing?.season);
      if (existing) {
        await env.DB.prepare("UPDATE claims SET price_cents = ?, season = ?, qty = ?, chip_in = ? WHERE item_id = ? AND season = ? AND buyer_id = ?")
          .bind(paid, s, n, wantChip ? 1 : 0, itemId, existing.season, me.id).run();
      } else {
        await env.DB.prepare("INSERT INTO claims (item_id, season, buyer_id, price_cents, created_at, qty, chip_in) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(itemId, s, me.id, paid, now(), n, wantChip ? 1 : 0)
          .run();
      }
      const started = wantChip && !groupOthers.length && !existing?.chip_in;
      if (started) ctx?.waitUntil(groupGiftStarted(env, me, item).catch((err) => console.error("group push", err)));
      return { ok: true, started };
    } else if (existing) {
      await env.DB.prepare("DELETE FROM claims WHERE item_id = ? AND season = ? AND buyer_id = ?").bind(itemId, existing.season, me.id).run();
      // An item the owner already removed disappears once nobody has bought it.
      if (item.removed_at && rows.length === 1) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM claims WHERE item_id = ?").bind(itemId),
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
    const { brands, as } = await body(req);
    const owner = await ownerFor(env, me, as);
    if (!Array.isArray(brands)) fail(400, "Pick some gift cards.");
    const keys = [...new Set(brands.map(String))].filter((k) => GIFT_CARD_NAMES.has(k));
    if (keys.length > LIMITS.giftCards) fail(400, "That's more gift cards than we can show.");
    const t = now();
    const marks = keys.map(() => "?").join(", ");
    await env.DB.batch([
      keys.length
        ? env.DB.prepare(`DELETE FROM gift_cards WHERE member_id = ? AND brand NOT IN (${marks})`).bind(owner, ...keys)
        : env.DB.prepare("DELETE FROM gift_cards WHERE member_id = ?").bind(owner),
      // Keeps the original date for brands already there, so the order on the list stays put.
      ...keys.map((k) => env.DB.prepare("INSERT OR IGNORE INTO gift_cards (member_id, brand, created_at) VALUES (?, ?, ?)").bind(owner, k, t)),
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
        `UPDATE private_ideas SET ${IMAGE_SET}, title = ?4, url = ?2, price_cents = ?5, note = ?6, shared = ?7, updated_at = ?3, details_v = ${DETAILS_V}
          WHERE id = ?8 AND author_id = ?9`,
      )
        .bind(image, fields[1], t, fields[0], fields[2], fields[3], fields[4], id, me.id)
        .run();
      if (!res.meta.changes) fail(404, "Idea not found.");
    } else {
      if (!b.subjectId || b.subjectId === me.id || !(await sharesGroup(env, me.id, b.subjectId))) fail(400, "Pick who this idea is for.");
      const { n: ideaCount } = await env.DB.prepare("SELECT COUNT(*) AS n FROM private_ideas WHERE author_id = ?").bind(me.id).first();
      if (ideaCount >= ABUSE.ideasPerMember) fail(409, `You have ${ABUSE.ideasPerMember} gift ideas, the most allowed. Delete a few to add more.`);
      id = newId();
      await env.DB.prepare(
        `INSERT INTO private_ideas (id, author_id, subject_id, title, url, price_cents, note, shared, created_at, updated_at, image_url, image_checked_at, details_v) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${DETAILS_V})`,
      )
        .bind(id, me.id, b.subjectId, ...fields, t, t, image, image ? t : null)
        .run();
    }
    await env.DB.prepare("UPDATE private_ideas SET price_auto = ? WHERE id = ?").bind(priceAuto(b, fields), id).run();
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

  // How a gift you bought is coming along: status (null = ordered / on the way, "home", "wrapped",
  // "given") and stash (where it's hidden). Only for your own purchases; nobody else ever sees these.
  // kind "item" / "idea": id is the item or idea. kind "giftcard": id is the brand, subjectId who it's for.
  // occasion: the purchase's occasion code (YYYYMMDD).
  async "POST purchase/progress"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const status = b.status == null || b.status === "" ? null : String(b.status);
    if (status !== null && !PURCHASE_STAGES.has(status)) fail(400, "Pick how it's going.");
    const stash = text(b.stash, LIMITS.stash, "Where it's hidden");
    const season = Number(b.occasion);
    if (!Number.isInteger(season) || season < today()) fail(400, "That occasion has passed.");
    const id = String(b.id || "");
    // Someone in your household can move along a gift they bought for a person outside it (shared budget).
    const buyer = b.buyerId ? String(b.buyerId) : me.id;
    if (buyer !== me.id) {
      const subjectSql = b.kind === "item" ? "SELECT owner_id AS s FROM items WHERE id = ?"
        : b.kind === "idea" ? "SELECT subject_id AS s FROM private_ideas WHERE id = ?" : "SELECT ? AS s";
      const subjectId = (await env.DB.prepare(subjectSql).bind(b.kind === "giftcard" ? String(b.subjectId || "") : id).first())?.s;
      const [myHh, them, subject] = await Promise.all([
        householdOf(env, me.id),
        householdOf(env, buyer),
        env.DB.prepare("SELECT id, household_id FROM members WHERE id = ?").bind(String(subjectId || "")).first(),
      ]);
      if (!myHh || them !== myHh || !subject || !sharesBudget(myHh, subject)) fail(404, "Purchase not found.");
    }
    let res;
    if (b.kind === "item") {
      res = await env.DB.prepare("UPDATE claims SET status = ?, stash = ? WHERE item_id = ? AND season = ? AND buyer_id = ?")
        .bind(status, stash, id, season, buyer).run();
    } else if (b.kind === "idea") {
      res = await env.DB.prepare("UPDATE idea_claims SET status = ?, stash = ? WHERE idea_id = ? AND season = ? AND buyer_id = ?")
        .bind(status, stash, id, season, buyer).run();
    } else if (b.kind === "giftcard") {
      res = await env.DB.prepare("UPDATE gift_card_gifts SET status = ?, stash = ? WHERE member_id = ? AND brand = ? AND season = ? AND buyer_id = ?")
        .bind(status, stash, String(b.subjectId || ""), id, season, buyer).run();
    } else fail(400, "Pick a purchase.");
    if (!res.meta?.changes) fail(404, "Purchase not found.");
    return { ok: true };
  },

  // Not doing gifts with someone (or a whole household): { target: "m:<id>" | "h:<householdId>", skip: true|false }.
  // Only changes your own budget page and reminders; nobody else ever sees it.
  async "POST budget/skip"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const target = String(b.target || "");
    const [kind, id] = [target.slice(0, 2), target.slice(2)];
    if (!id || (kind !== "m:" && kind !== "h:")) fail(400, "Pick who to leave out.");
    if (kind === "m:" && (id === me.id || !(await sharesGroup(env, me.id, id)))) fail(404, "Person not found.");
    if (kind === "h:") {
      const row = await env.DB.prepare(
        `SELECT 1 FROM members m JOIN group_members gm ON gm.member_id = m.id
          WHERE m.household_id = ? AND m.id != ? AND gm.group_id IN (SELECT group_id FROM group_members WHERE member_id = ?) LIMIT 1`,
      ).bind(id, me.id, me.id).first();
      if (!row) fail(404, "Household not found.");
    }
    if (b.skip) {
      await env.DB.prepare("INSERT INTO budget_skips (author_id, target, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(me.id, target, now()).run();
    } else {
      await env.DB.prepare("DELETE FROM budget_skips WHERE author_id = ? AND target = ?").bind(me.id, target).run();
    }
    return { ok: true };
  },

  // Set (amount) or clear (empty amount) your budget for one person for one occasion
  // (occasion: YYYYMMDD of their Christmas or birthday; absent = the soonest). For someone outside your
  // household this is your household's shared budget (their whole household's at Christmas).
  async "POST budget"(req, env) {
    const me = await auth(req, env);
    const { subjectId, amount, occasion } = await body(req);
    if (!subjectId || subjectId === me.id || !(await sharesGroup(env, me.id, subjectId))) fail(400, "Pick who this budget is for.");
    const s = await pickOccasion(env, subjectId, occasion);
    const value = cents(amount);
    const [myHh, subject] = await Promise.all([
      householdOf(env, me.id),
      env.DB.prepare("SELECT id, household_id FROM members WHERE id = ?").bind(String(subjectId)).first(),
    ]);
    if (sharesBudget(myHh, subject)) {
      const target = budgetTarget(subject, s);
      if (value === null) {
        await env.DB.prepare("DELETE FROM household_budgets WHERE household_id = ? AND target = ? AND season = ?").bind(myHh, target, s).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO household_budgets (household_id, target, season, amount_cents, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (household_id, target, season) DO UPDATE SET amount_cents = excluded.amount_cents, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        ).bind(myHh, target, s, value, me.id, now()).run();
      }
      return { ok: true };
    }
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

  // Details refresh (see refreshRow): a few of your own wishes and ideas per call. The app calls this after
  // signing in until remaining is 0, then redraws.
  async "POST refresh"(req, env) {
    const me = await auth(req, env);
    // Over the limit: report nothing left, so the app stops asking until next time.
    if (!(await underLimit(env, `refresh:${me.id}`, ABUSE.refreshPerMember))) return { checked: 0, updated: 0, remaining: 0 };
    const pick = (table, owner) => env.DB.prepare(
      `SELECT id, url FROM ${table} WHERE ${owner} = ? AND url IS NOT NULL AND url != '' AND details_v < ?${table === "items" ? " AND removed_at IS NULL" : ""} ORDER BY created_at DESC LIMIT ?`,
    ).bind(me.id, DETAILS_V, REFRESH_BATCH).all();
    const items = (await pick("items", "owner_id")).results.map((r) => ["items", r]);
    const ideas = items.length < REFRESH_BATCH ? (await pick("private_ideas", "author_id")).results.map((r) => ["private_ideas", r]) : [];
    const batch = [...items, ...ideas].slice(0, REFRESH_BATCH);
    const done = await Promise.all(batch.map(([table, row]) => refreshRow(env, table, row)));
    const count = (table, owner) => env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${owner} = ? AND url IS NOT NULL AND url != '' AND details_v < ?${table === "items" ? " AND removed_at IS NULL" : ""}`,
    ).bind(me.id, DETAILS_V).first("n");
    const remaining = (await count("items", "owner_id")) + (await count("private_ideas", "author_id"));
    return { checked: batch.length, updated: done.filter(Boolean).length, remaining };
  },

  // Price guess for a wish or idea with no price. Anyone who can see it may ask; guessed once and shared.
  async "POST estimate"(req, env) {
    const me = await auth(req, env);
    const { kind, id } = await body(req);
    if (!(await underLimit(env, `estimate:${me.id}`, ABUSE.estimatePerMember))) return { price_est: null };
    let row;
    if (kind === "item") {
      row = await env.DB.prepare(
        `SELECT i.id, i.title, i.url, i.brand, i.size, i.color, i.price_cents, i.price_est_cents FROM items i
           LEFT JOIN claims c ON c.item_id = i.id AND c.buyer_id = ?
          WHERE i.id = ? AND (i.owner_id = ? OR ${ITEM_VISIBLE} OR c.item_id IS NOT NULL)`,
      ).bind(me.id, id, me.id, me.id).first();
    } else if (kind === "idea") {
      const idea = await env.DB.prepare(`${IDEA_SELECT} WHERE p.id = ?`).bind(today(), id).first();
      if (idea && (await canSeeIdea(env, me.id, idea))) row = idea;
    }
    if (!row) fail(404, "Not found.");
    if (row.price_cents != null) return { price_est: null };
    if (row.price_est_cents != null) return { price_est: row.price_est_cents > 0 ? row.price_est_cents : null };
    const est = await estimatePrice(env, row).catch(() => undefined);
    if (est === undefined) return { price_est: null };
    const table = kind === "item" ? "items" : "private_ideas";
    await env.DB.prepare(`UPDATE ${table} SET price_est_cents = ? WHERE id = ? AND title IS ? AND url IS ? AND price_est_cents IS NULL`)
      .bind(est ?? -1, row.id, row.title, row.url).run();
    console.log(`estimate ${kind} -> ${est != null ? `$${est / 100}` : "none"}`);
    return { price_est: est };
  },

  // Product photo for an item or idea saved before photos existed (or whose link changed). Anyone who
  // can see it may ask; the lookup runs once per link, and the result is shared with everyone.
  async "POST image"(req, env) {
    const me = await auth(req, env);
    const { kind, id } = await body(req);
    if (!(await underLimit(env, `image:${me.id}`, ABUSE.imagePerMember))) return { image: null, price_cents: null };
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
         price_auto = CASE WHEN price_cents IS NULL AND ?3 IS NOT NULL THEN 1 ELSE price_auto END,
         price_cents = CASE WHEN price_cents IS NULL THEN ?3 ELSE price_cents END
        WHERE id = ?4 AND url IS ?5`,
    ).bind(image, now(), price, row.id, row.url).run();
    return { image, price_cents: price };
  },

  // Live prices for wishes and ideas on a list you're looking at. keys: ["item:<id>", "idea:<id>"], up to 12.
  // Only things you can see; Gemini lookups (blocked stores) run a few at a time.
  async "POST prices"(req, env) {
    const me = await auth(req, env);
    if (!(await underLimit(env, `prices:${me.id}`, ABUSE.pricesPerMember))) return { prices: {} };
    const { keys } = await body(req);
    const want = [...new Set((Array.isArray(keys) ? keys : []).map(String))].slice(0, 12);
    const rows = [];
    for (const key of want) {
      const [kind, id] = key.split(":");
      let row = null;
      if (kind === "item") {
        row = await env.DB.prepare(
          `SELECT i.id, i.url, i.price_cents, i.price_auto FROM items i LEFT JOIN claims c ON c.item_id = i.id AND c.buyer_id = ?
            WHERE i.id = ? AND (i.owner_id = ? OR ${ITEM_VISIBLE} OR c.item_id IS NOT NULL)`,
        ).bind(me.id, id, me.id, me.id).first();
      } else if (kind === "idea") {
        const idea = await env.DB.prepare(`${IDEA_SELECT} WHERE p.id = ?`).bind(today(), id).first();
        if (idea && (await canSeeIdea(env, me.id, idea))) row = idea;
      }
      if (row?.url) rows.push([key, row.url, row]);
    }
    const prices = {};
    for (let i = 0; i < rows.length; i += 4) {
      await Promise.all(rows.slice(i, i + 4).map(async ([key, u, row]) => {
        const p = await livePrice(env, u).catch(() => null);
        if (p && (p.price != null || p.inStock !== null)) prices[key] = { price: p.price, inStock: p.inStock, site: p.site, checkedAt: p.checkedAt };
        // A price that came from the link follows the store. Hand-typed prices are never touched.
        const cur = p?.price != null ? Math.round(p.price * 100) : null;
        if (cur != null && row.price_auto && cur !== row.price_cents) {
          const table = key.startsWith("item:") ? "items" : "private_ideas";
          await env.DB.prepare(`UPDATE ${table} SET price_cents = ? WHERE id = ? AND url IS ? AND price_auto = 1`)
            .bind(cur, row.id, u).run().catch(() => {});
          prices[key].synced = cur;
        }
      }));
    }
    return { prices };
  },

  // Autofill: read a product link and return its name and price (nothing is saved).
  async "POST preview"(req, env) {
    const me = await auth(req, env);
    const { url, hint } = await body(req);
    await rateLimit(env, `preview:${me.id}`, ABUSE.previewPerMember, "That's a lot of links for now. Type the details in, or try again in a bit.");
    return previewLink(env, url, { ai: true, hint: typeof hint === "string" ? hint.slice(0, 150) : "" });
  },

  // The ✨ button: Gemini rewrites a messy wish name into a short, clear one. Nothing is saved.
  async "POST name"(req, env) {
    const me = await auth(req, env);
    if (!env.GEMINI_API_KEY) fail(500, "AI names aren't set up (missing GEMINI_API_KEY).");
    const b = await body(req);
    const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
    const title = str(b.title, LIMITS.title), url = str(b.url, LIMITS.url), brand = str(b.brand, LIMITS.brand);
    if (!title && !url) fail(400, "Type a name or paste a link first.");
    const avoid = (Array.isArray(b.avoid) ? b.avoid : []).map((x) => str(x, LIMITS.title)).filter(Boolean).slice(-5);
    await rateLimit(env, `name:${me.id}`, ABUSE.namePerMember, "That's a lot of new names for now. Try again in a bit, or type it in.");
    const r = await callGemini(env, NAME_PROMPT, [{ text: JSON.stringify({ name: title, link: url, brand, avoid }) }], NAME_SCHEMA, 15000);
    if (r.error) return r.error;
    const out = decode(String(r.data?.title || "")).replace(/\s+/g, " ").trim().slice(0, LIMITS.title);
    if (!out) fail(502, "Couldn't come up with a name. Try again.");
    return { title: out };
  },

  // Photo to suggestions: Gemini guesses what the item is and finds a store page for each. Nothing is stored.
  async "POST identify"(req, env) {
    const me = await auth(req, env);
    if (!env.GEMINI_API_KEY) fail(500, "Photo search isn't set up (missing GEMINI_API_KEY).");
    const { image } = await body(req, ABUSE.maxPhotoBody);
    await rateLimit(env, `identify:${me.id}`, ABUSE.identifyPerMember, "That's a lot of photo searches for now. Try again later, or type it in.");
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

  // Your planner: per person, their upcoming occasions (Christmas, and their birthday if they added one), each
  // with your budget and what was bought for it (list items, ideas, gift cards) with what was paid, plus your
  // open ideas. Only ever about other people. For people outside your household the budget and purchases are
  // your household's (see sharesBudget); at Christmas the budget covers their whole household, so their
  // Christmas occasion carries that household's budget and spending (with `household` set).
  async "GET tracker"(req, env) {
    const me = await auth(req, env);
    const t = today();
    const myHh = await householdOf(env, me.id);
    const team = await givers(env, me, myHh);
    const skips = await skipsFor(env, me.id);
    const teamIds = team.map((x) => x.id);
    const inTeam = teamIds.map(() => "?").join(",");
    const [people, budgets, shared, itemBuys, ideaBuys, ideas, cardGifts] = await Promise.all([
      env.DB.prepare(
        `SELECT DISTINCT m.id, m.name, m.photo_at, m.birthday, m.household_id FROM group_members gm JOIN members m ON m.id = gm.member_id
          WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_id = ?) AND m.id != ?
          ORDER BY m.name COLLATE NOCASE`,
      ).bind(me.id, me.id).all(),
      env.DB.prepare("SELECT subject_id, season, amount_cents FROM budgets WHERE author_id = ? AND season >= ?").bind(me.id, t).all(),
      myHh
        ? env.DB.prepare("SELECT target, season, amount_cents FROM household_budgets WHERE household_id = ? AND season >= ?").bind(myHh, t).all()
        : Promise.resolve({ results: [] }),
      env.DB.prepare(
        `SELECT i.owner_id AS subject_id, i.id, i.title, i.url, i.price_cents AS list_cents, c.price_cents AS paid_cents, c.created_at, c.season, c.status, c.stash, c.qty, c.chip_in, c.buyer_id
           FROM claims c JOIN items i ON i.id = c.item_id WHERE c.buyer_id IN (${inTeam}) AND c.season >= ? ORDER BY c.created_at`,
      ).bind(...teamIds, t).all(),
      env.DB.prepare(
        `SELECT p.subject_id, p.id, p.title, p.url, p.price_cents AS list_cents, c.price_cents AS paid_cents, c.created_at, c.season, c.status, c.stash, c.buyer_id,
                p.author_id, a.name AS author_name
           FROM idea_claims c JOIN private_ideas p ON p.id = c.idea_id JOIN members a ON a.id = p.author_id
          WHERE c.buyer_id IN (${inTeam}) AND c.season >= ? ORDER BY c.created_at`,
      ).bind(...teamIds, t).all(),
      env.DB.prepare(`${IDEA_SELECT} WHERE p.author_id = ? AND c.buyer_id IS NULL ORDER BY p.updated_at DESC`).bind(t, me.id).all(),
      env.DB.prepare(
        `SELECT member_id AS subject_id, brand, season, amount_cents, created_at, status, stash, buyer_id FROM gift_card_gifts WHERE buyer_id IN (${inTeam}) AND season >= ? ORDER BY created_at`,
      ).bind(...teamIds, t).all(),
    ]);
    const nicks = await nicknamesFor(env, me.id);
    const byId = new Map(people.results.map((p) => [p.id, p]));
    const isShared = (subjectId) => { const p = byId.get(subjectId); return !!p && sharesBudget(myHh, p); };
    // Your own purchases, plus your household's for people outside it.
    const counts = (r) => r.buyer_id === me.id || isShared(r.subject_id);
    const buyerName = (id) => (id === me.id ? me.name : nicks.get(id) || team.find((x) => x.id === id)?.name || "Someone");
    const purchase = (kind) => (r) => ({
      kind,
      id: r.id,
      subject_id: r.subject_id,
      occasion: r.season,
      title: r.title,
      url: r.url,
      list_cents: r.list_cents,
      paid_cents: r.paid_cents,
      // A group gift counts only your share (nothing until you enter it). Several of one wish count each one.
      spent_cents: r.paid_cents ?? (r.chip_in ? 0 : r.list_cents == null ? 0 : r.list_cents * (r.qty || 1)),
      qty: r.qty || 1,
      chipIn: !!r.chip_in,
      date: r.created_at,
      status: r.status || null,
      stash: r.stash || null,
      mine: r.buyer_id === me.id,
      buyerId: r.buyer_id,
      buyerName: buyerName(r.buyer_id),
      from: kind === "item" ? (r.chip_in ? "Group gift" : "Their list") : r.author_id === me.id ? "My idea" : r.author_id === r.buyer_id ? `${buyerName(r.author_id)}'s idea` : `Suggested by ${nicks.get(r.author_id) || r.author_name}`,
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
      status: r.status || null,
      stash: r.stash || null,
      mine: r.buyer_id === me.id,
      buyerId: r.buyer_id,
      buyerName: buyerName(r.buyer_id),
      from: "Gift card",
    });
    const purchases = [...itemBuys.results.filter(counts).map(purchase("item")), ...ideaBuys.results.filter(counts).map(purchase("idea")), ...cardGifts.results.filter(counts).map(cardBuy)]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const sharedBudget = (target, code) => shared.results.find((b) => b.target === target && b.season === code)?.amount_cents ?? null;
    // Households you plan Christmas for as a whole (people outside yours who are in one), with who's in them.
    const households = {};
    for (const p of people.results) {
      if (!p.household_id || !sharesBudget(myHh, p)) continue;
      (households[p.household_id] ||= { id: p.household_id, members: [] }).members.push(p);
    }
    const hhIds = Object.keys(households);
    if (hhIds.length) {
      const { results } = await env.DB.prepare(`SELECT id, name FROM households WHERE id IN (${hhIds.map(() => "?").join(",")})`).bind(...hhIds).all();
      for (const h of results) households[h.id].name = h.name || null;
    }
    for (const h of Object.values(households)) {
      h.label = householdLabel(h.name, h.members.map((p) => nicks.get(p.id) || p.name));
      h.members = h.members.map((p) => p.id);
      delete h.name;
    }
    return {
      today: t,
      // People and households you're not doing gifts with ('m:<id>' / 'h:<id>'). Only yours.
      skips: [...skips],
      // Who shares your budgets for people outside your household (empty when you have no household).
      sharedWith: myHh ? team.filter((x) => x.id !== me.id).map((x) => ({ id: x.id, name: nicks.get(x.id) || x.name })) : [],
      households,
      people: people.results.map((p) => {
        const occasions = occasionsFor(p, t);
        const mine = (rows) => rows.filter((x) => x.subject_id === p.id);
        const shares = sharesBudget(myHh, p);
        // A mark or budget filed under an old birthday date (they changed it) still shows until that date passes.
        const sharedCodes = shared.results.filter((b) => b.target === `m:${p.id}`).map((b) => b.season);
        for (const code of new Set([...(shares ? sharedCodes : mine(budgets.results).map((b) => b.season)), ...mine(purchases).map((x) => x.occasion)])) {
          if (!occasions.some((o) => o.code === code)) {
            const xmas = isXmasCode(code);
            occasions.push({ code, date: isoOf(code), christmas: xmas, birthday: !xmas });
          }
        }
        occasions.sort((a, b) => a.code - b.code);
        return {
          id: p.id,
          name: nicks.get(p.id) || p.name,
          fullName: p.name,
          photo: p.photo_at || null,
          birthday: bdayOf(p),
          householdId: p.household_id || null,
          shared: shares,
          skipped: isSkipped(skips, p),
          occasions: occasions.map((o) => {
            const bought = mine(purchases).filter((x) => x.occasion === o.code);
            const ownSpent = bought.reduce((sum, x) => sum + x.spent_cents, 0);
            if (!shares) {
              return { ...o, budget_cents: mine(budgets.results).find((b) => b.season === o.code)?.amount_cents ?? null, spent_cents: ownSpent, own_spent_cents: ownSpent, purchases: bought };
            }
            const target = budgetTarget(p, o.code);
            if (target.startsWith("h:")) {
              // Their household's Christmas: one budget, everything bought for any of them counts.
              const members = households[p.household_id].members;
              const spent = purchases.filter((x) => x.occasion === o.code && members.includes(x.subject_id)).reduce((sum, x) => sum + x.spent_cents, 0);
              return { ...o, budget_cents: sharedBudget(target, o.code), spent_cents: spent, own_spent_cents: ownSpent, household: p.household_id, purchases: bought };
            }
            return { ...o, budget_cents: sharedBudget(target, o.code), spent_cents: ownSpent, own_spent_cents: ownSpent, purchases: bought };
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
    await rateLimit(env, `lookup:ip:${ipOf(req)}`, ABUSE.lookupPerIp, "Too many tries. Wait a bit, then check the code and try again.");
    const group = await groupByCode(env, (await body(req)).code);
    const already = await env.DB.prepare("SELECT direct FROM group_members WHERE group_id = ? AND member_id = ?").bind(group.id, me.id).first();
    if (already?.direct) fail(409, `You're already in ${group.name}.`);
    if (already) {
      // In it through your household: joining yourself means you stay even if you leave the household.
      await env.DB.prepare("UPDATE group_members SET direct = 1 WHERE group_id = ? AND member_id = ?").bind(group.id, me.id).run();
      return { group: { id: group.id, name: group.name } };
    }
    const clash = await env.DB.prepare(
      `SELECT 1 FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND ${SAME_SLOT}`,
    )
      .bind(group.id, me.name, me.lastName, await householdOf(env, me.id))
      .first();
    if (clash) fail(409, me.lastName ? `${me.name} ${me.lastName} is already in ${group.name}.` : `Someone named ${me.name} is already in ${group.name}. Add your last name in Profile, then join.`);
    await circleSlot(env, me.id);
    await circleRoom(env, group.id);
    await env.DB.prepare(JOIN_DIRECT).bind(group.id, me.id, now()).run();
    return { group: { id: group.id, name: group.name } };
  },

  // Start another family while signed in.
  async "POST family/start"(req, env) {
    const me = await auth(req, env);
    const name = text((await body(req)).groupName, LIMITS.group, "Circle name", true);
    await circleSlot(env, me.id);
    await rateLimit(env, `start:m:${me.id}`, ABUSE.circlesStartedPerMemberDay, "That's a lot of new circles today. Try again tomorrow.");
    if ((await hit(env, "newcircle:all", 86400)) > ABUSE.newCirclesPerDay) fail(429, "Hints isn't taking new circles right now. Try again tomorrow.");
    const id = newId();
    const t = now();
    const code = await newUniqueJoinCode(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO groups (id, name, join_code, created_at, created_by) VALUES (?, ?, ?, ?, ?)").bind(id, name, code, t, me.id),
      env.DB.prepare(JOIN_DIRECT).bind(id, me.id, t),
    ]);
    return { group: { id, name, code } };
  },

  // Rename a circle, or set or remove its photo. Only the circle's admin.
  // photo: a small JPEG data URL (the app squares it first), "" removes it, absent leaves it alone.
  async "POST family/edit"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const g = await env.DB.prepare(
      "SELECT g.id, g.created_by FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE g.id = ? AND gm.member_id = ?",
    ).bind(String(b.groupId || ""), me.id).first();
    if (!g) fail(404, "Circle not found.");
    if ((await adminOf(env, g.id)) !== me.id) fail(403, "Only the circle's admin can change it.");
    const rows = [];
    if (b.name !== undefined) rows.push(env.DB.prepare("UPDATE groups SET name = ? WHERE id = ?").bind(text(b.name, LIMITS.group, "Circle name", true), g.id));
    if (b.photo !== undefined) {
      const photo = photoValue(b.photo);
      rows.push(env.DB.prepare("UPDATE groups SET photo = ?, photo_at = ? WHERE id = ?").bind(photo, photo ? now() : null, g.id));
    }
    if (rows.length) await env.DB.batch(rows);
    return { ok: true };
  },

  // Hand a circle's admin to someone else in it. Only the current admin.
  async "POST family/admin"(req, env) {
    const me = await auth(req, env);
    const { groupId, memberId } = await body(req);
    if (!(await myGroupIds(env, me.id)).includes(groupId)) fail(404, "Circle not found.");
    if ((await adminOf(env, groupId)) !== me.id) fail(403, "Only the circle's admin can pick a new admin.");
    if (!memberId || memberId === me.id) fail(400, "Pick someone else.");
    const them = await env.DB.prepare(
      "SELECT m.managed_by FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND gm.member_id = ?",
    ).bind(groupId, String(memberId)).first();
    if (!them) fail(404, "They aren't in this circle.");
    if (them.managed_by) fail(400, "Pick someone who uses the app.");
    await env.DB.prepare("UPDATE groups SET created_by = ? WHERE id = ?").bind(String(memberId), groupId).run();
    return { ok: true };
  },

  // Take someone out of a circle. Only the circle's admin, and not themselves (they use Leave).
  // Someone whose household is in the circle comes out with the household instead (Manage households).
  // If it was their only circle they're signed out everywhere, since there'd be nothing left to show them.
  async "POST family/remove"(req, env) {
    const me = await auth(req, env);
    const { groupId, memberId } = await body(req);
    if (!(await myGroupIds(env, me.id)).includes(groupId)) fail(404, "Circle not found.");
    if ((await adminOf(env, groupId)) !== me.id) fail(403, "Only the circle's admin can take people out.");
    if (!memberId || memberId === me.id) fail(400, "To take yourself out, leave the circle instead.");
    const them = await env.DB.prepare(
      "SELECT m.name, m.household_id FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND m.id = ?",
    ).bind(groupId, String(memberId)).first();
    if (!them) fail(404, "They aren't in this circle.");
    if (them.household_id) {
      const viaHousehold = await env.DB.prepare("SELECT 1 FROM group_households WHERE group_id = ? AND household_id = ?").bind(groupId, them.household_id).first();
      if (viaHousehold) fail(409, `${them.name}'s household is in this circle. Take them out of the household first, or take the whole household out.`);
    }
    const others = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_members WHERE member_id = ? AND group_id != ?").bind(memberId, groupId).first();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND member_id = ?").bind(groupId, memberId),
      env.DB.prepare("DELETE FROM item_hidden WHERE group_id = ? AND item_id IN (SELECT id FROM items WHERE owner_id = ?)").bind(groupId, memberId),
      ...(others.n ? [] : [env.DB.prepare("DELETE FROM devices WHERE member_id = ?").bind(memberId)]),
    ]);
    return { ok: true };
  },

  // Leave one of your families (not your last one). Your list stays; that family just stops seeing it.
  async "POST family/leave"(req, env) {
    const me = await auth(req, env);
    const { groupId } = await body(req);
    const mine = await myGroupIds(env, me.id);
    if (!mine.includes(groupId)) fail(404, "Circle not found.");
    if (mine.length < 2) fail(400, "You can't leave your only circle.");
    const viaHousehold = await env.DB.prepare(
      "SELECT 1 FROM group_households gh JOIN members m ON m.household_id = gh.household_id WHERE gh.group_id = ? AND m.id = ?",
    ).bind(groupId, me.id).first();
    if (viaHousehold) fail(409, "Your whole household is in this circle. Take your household out of it in Settings, or leave your household first.");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND member_id = ?").bind(groupId, me.id),
      env.DB.prepare("DELETE FROM item_hidden WHERE group_id = ? AND item_id IN (SELECT id FROM items WHERE owner_id = ?)").bind(groupId, me.id),
    ]);
    await adminOf(env, groupId);
    return { ok: true };
  },

  // ---------- notifications ----------

  // The app's public key, for pushManager.subscribe({ applicationServerKey }).
  async "GET push/key"(req, env) {
    await auth(req, env);
    return { key: (await vapidKeys(env)).pub };
  },

  // Turn notifications on for this device. subscription: PushSubscription.toJSON(). Tied to this sign-in
  // (device token): signing out or being signed out ends it. The app also calls this on every start to keep it current.
  async "POST push/subscribe"(req, env) {
    const me = await auth(req, env);
    const { subscription: sub } = await body(req);
    const endpoint = String(sub?.endpoint || "");
    const p256dh = String(sub?.keys?.p256dh || ""), key = String(sub?.keys?.auth || "");
    if (!pushEndpointOk(endpoint, env) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(key)) fail(400, "That browser's notifications didn't work.");
    await env.DB.prepare(
      `INSERT INTO push_subs (endpoint, member_id, p256dh, auth, created_at, device_token) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth,
         device_token = excluded.device_token`,
    ).bind(endpoint, me.id, p256dh, key, now(), me.token).run();
    // Keep the newest few devices per person.
    await env.DB.prepare(
      "DELETE FROM push_subs WHERE member_id = ?1 AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE member_id = ?1 ORDER BY created_at DESC LIMIT ?2)",
    ).bind(me.id, ABUSE.pushSubsPerMember).run();
    return { ok: true };
  },

  async "POST push/unsubscribe"(req, env) {
    const me = await auth(req, env);
    const { endpoint } = await body(req);
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ? AND member_id = ?").bind(String(endpoint || ""), me.id).run();
    return { ok: true };
  },

  // Which kinds you want: { wishes, birthdays, groupGifts } (absent = unchanged).
  async "POST push/prefs"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const row = await env.DB.prepare("SELECT notify FROM members WHERE id = ?").bind(me.id).first();
    const prefs = notifyPrefs(row?.notify);
    for (const k of NOTIFY_KINDS) if (b[k] !== undefined) prefs[k] = !!b[k];
    await env.DB.prepare("UPDATE members SET notify = ? WHERE id = ?").bind(JSON.stringify(prefs), me.id).run();
    return { notify: prefs };
  },

  // A test notification to every device you turned on.
  async "POST push/test"(req, env) {
    const me = await auth(req, env);
    await rateLimit(env, `pushtest:${me.id}`, ABUSE.pushTestPerMember);
    const sent = await pushTo(env, me.id, { title: "Notifications are on 🎁", body: "You'll hear about new wishes, birthdays and group gifts here.", url: "/#mine", tag: "test" }, { anyTime: true });
    if (!sent) fail(502, "That didn't go through. Turn notifications off and on again on this device.");
    return { sent };
  },

  // The "N new" badges: { ownerId, count } after opening someone's list, or { seen: { ownerId: count } } to copy
  // what a device remembered from before this was on the server (merge: only fills people with no count yet).
  // Only people you share a circle with.
  async "POST seen"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const entries = b.seen && typeof b.seen === "object" ? Object.entries(b.seen).slice(0, 300) : [[b.ownerId, b.count]];
    const onConflict = b.seen && b.merge ? "DO NOTHING" : "DO UPDATE SET seen_count = excluded.seen_count, seen_at = excluded.seen_at";
    const t = now();
    const rows = entries
      .filter(([id, n]) => typeof id === "string" && id && id !== me.id && Number.isInteger(n) && n >= 0 && n < 100000)
      .map(([id, n]) => env.DB.prepare(
        `INSERT INTO list_seen (viewer_id, owner_id, seen_count, seen_at)
         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM group_members x JOIN group_members y ON y.group_id = x.group_id WHERE x.member_id = ?1 AND y.member_id = ?2)
         ON CONFLICT (viewer_id, owner_id) ${onConflict}`,
      ).bind(me.id, id, n, t));
    if (rows.length) await env.DB.batch(rows);
    return { ok: true };
  },

  // "Looks good" on the yearly "Your list hasn't changed since last year" card: hides it on every device and
  // skips that year's reminder notification.
  async "POST stale/ok"(req, env) {
    const me = await auth(req, env);
    await env.DB.prepare("UPDATE members SET stale_ok_year = ? WHERE id = ?").bind(Math.floor(today() / 10000), me.id).run();
    return { ok: true };
  },

  // ---------- people you look after ----------

  // Add someone who doesn't use the app (a kid, a grandparent), or isn't on it yet. groupIds: which of your
  // circles they're in (absent = all of them). They join your household too if you have one, so everyone in it
  // can run their list. householdId: put them in that household instead (one you can organize, see
  // manageableHousehold); then they're only in its circles unless groupIds says more.
  async "POST managed/add"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const name = text(b.name, LIMITS.name, "Their first name", true);
    const lastName = lastNameOf(b.lastName);
    const mine = await myGroupIds(env, me.id);
    // Your household only when you add them to it (joinHousehold); older apps don't send it and keep the old default.
    const hh = b.householdId ? await manageableHousehold(env, me.id, b.householdId) : b.joinHousehold === false ? null : await householdOf(env, me.id);
    const picked = Array.isArray(b.groupIds) ? [...new Set(b.groupIds.map(String))].filter((g) => mine.includes(g)) : b.householdId ? [] : mine;
    const hhCircles = hh ? (await env.DB.prepare("SELECT group_id FROM group_households WHERE household_id = ?").bind(hh).all()).results.map((r) => r.group_id) : [];
    if (!picked.length && !hhCircles.length) fail(400, "Pick at least one circle.");
    for (const g of new Set([...picked, ...hhCircles])) {
      const clash = await env.DB.prepare(
        `SELECT g.name FROM group_members gm JOIN members m ON m.id = gm.member_id JOIN groups g ON g.id = gm.group_id WHERE gm.group_id = ? AND ${SAME_SLOT}`,
      ).bind(g, name, lastName, hh).first();
      if (clash) fail(409, clashMsg(name, lastName, clash.name));
      await circleRoom(env, g);
    }
    const { n: managedCount } = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE managed_by = ?").bind(me.id).first();
    if (managedCount >= ABUSE.managedPerMember) fail(409, `You look after ${managedCount} people, the most allowed.`);
    await rateLimit(env, `managed:${me.id}`, ABUSE.managedAddsPerMemberDay, "That's a lot of new people today. Try again tomorrow.");
    if ((await hit(env, "newmember:all", 86400)) > ABUSE.newMembersPerDay) fail(429, "Hints isn't taking new people right now. Try again tomorrow.");
    const id = newId();
    const t = now();
    await env.DB.batch([
      // onboarded_at: there's no welcome tour for someone who never opens the app.
      env.DB.prepare("INSERT INTO members (id, name, last_name, created_at, managed_by, household_id, onboarded_at, is_kid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, name, lastName, t, me.id, hh, t, b.kid ? 1 : 0),
      ...picked.map((g) => env.DB.prepare(JOIN_DIRECT).bind(g, id, t)),
      ...hhCircles.map((g) => env.DB.prepare(
        "INSERT INTO group_members (group_id, member_id, joined_at, direct) VALUES (?, ?, ?, 0) ON CONFLICT DO NOTHING",
      ).bind(g, id, t)),
    ]);
    return { id };
  },

  // Hand someone's list over to them: they can now pick their name on the sign-in screen, and from then on
  // they never see purchased marks, like everyone else. Their managers can no longer edit it.
  async "POST managed/release"(req, env) {
    const me = await auth(req, env);
    const { memberId } = await body(req);
    if (!(await canManage(env, me.id, memberId))) fail(404, "Person not found.");
    await env.DB.prepare("UPDATE members SET managed_by = NULL, claim_hash = NULL, claim_expires = NULL WHERE id = ?").bind(String(memberId)).run();
    return { ok: true };
  },

  // Hand someone you look after to another person in their circle, who uses the app (a cousin takes over her
  // baby's list). They become the one who added them, and the person moves into their household (or out of
  // yours, if they have none) so their household can run the list too. They stay in every circle they share
  // with the new manager. Any pending personal invite link stops working. { memberId, toId }
  async "POST managed/handoff"(req, env) {
    const me = await auth(req, env);
    const { memberId, toId } = await body(req);
    if (!(await canManage(env, me.id, memberId))) fail(404, "Person not found.");
    const id = String(memberId);
    const [them, to] = await Promise.all([
      env.DB.prepare("SELECT id, name, household_id FROM members WHERE id = ?").bind(id).first(),
      env.DB.prepare("SELECT id, name, managed_by, household_id FROM members WHERE id = ?").bind(String(toId || "")).first(),
    ]);
    if (!to || to.id === id || to.managed_by) fail(400, "Pick someone who uses the app.");
    if (!(await sharesGroup(env, to.id, id))) fail(400, `${to.name} isn't in a circle with ${them.name}.`);
    if (them.household_id !== to.household_id) {
      if (to.household_id) {
        const { results } = await env.DB.prepare("SELECT group_id FROM group_households WHERE household_id = ?").bind(to.household_id).all();
        const fresh = [];
        for (const r of results) {
          const inIt = await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND member_id = ?").bind(r.group_id, id).first();
          if (!inIt) fresh.push(r.group_id);
        }
        const clash = await nameClash(env, fresh, [id], to.household_id);
        if (clash) fail(409, `Someone named ${them.name} is already in ${clash}. Add their last name first.`);
        for (const g of fresh) await circleRoom(env, g);
      }
      // Keep them in every circle they share with the new manager, even ones they were only in through the old household.
      await env.DB.prepare(
        "UPDATE group_members SET direct = 1 WHERE member_id = ? AND group_id IN (SELECT group_id FROM group_members WHERE member_id = ?)",
      ).bind(id, to.id).run();
      await leaveHousehold(env, id);
      if (to.household_id) {
        await env.DB.batch([
          env.DB.prepare("UPDATE members SET household_id = ? WHERE id = ?").bind(to.household_id, id),
          env.DB.prepare(
            "INSERT INTO group_members (group_id, member_id, joined_at, direct) SELECT group_id, ?, ?, 0 FROM group_households WHERE household_id = ? ON CONFLICT DO NOTHING",
          ).bind(id, now(), to.household_id),
        ]);
      }
    }
    await env.DB.prepare("UPDATE members SET managed_by = ?, claim_hash = NULL, claim_expires = NULL WHERE id = ?").bind(to.id, id).run();
    return { ok: true, name: to.name };
  },

  // A personal invite link for someone who isn't on Hints yet. Opening it signs them in as themselves and hands
  // the list over (POST claim), so there's no shared PIN and they don't pick their name. A new link replaces the
  // old one. Returns { token, expires }; the app builds /join/CODE?from=ME&hi=TOKEN.
  async "POST managed/invite"(req, env) {
    const me = await auth(req, env);
    const { memberId } = await body(req);
    if (!(await canManage(env, me.id, memberId))) fail(404, "Person not found.");
    await rateLimit(env, `invite:m:${me.id}`, ABUSE.invitesPerMemberDay, "That's a lot of invites today. Try again tomorrow.");
    const token = randomString(24, "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789");
    const expires = new Date(Date.now() + CLAIM_DAYS * 86_400_000).toISOString();
    await env.DB.prepare("UPDATE members SET claim_hash = ?, claim_expires = ? WHERE id = ?").bind(await sha256(token), expires, String(memberId)).run();
    return { token, expires };
  },

  // Turn off someone's personal invite link (it stops working).
  async "POST managed/uninvite"(req, env) {
    const me = await auth(req, env);
    const { memberId } = await body(req);
    if (!(await canManage(env, me.id, memberId))) fail(404, "Person not found.");
    await env.DB.prepare("UPDATE members SET claim_hash = NULL, claim_expires = NULL WHERE id = ?").bind(String(memberId)).run();
    return { ok: true };
  },

  // Opening a personal invite link: who it's for and who set it up. { token }
  async "POST claim/lookup"(req, env) {
    const b = await body(req);
    await rateLimit(env, `lookup:ip:${ipOf(req)}`, ABUSE.lookupPerIp, "Too many tries. Wait a bit and try again.");
    const them = await claimFor(env, b.token);
    const by = await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(them.managed_by).first();
    const { results: wishes } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM items WHERE owner_id = ? AND removed_at IS NULL AND draft = 0",
    ).bind(them.id).all();
    const { results: circles } = await env.DB.prepare(
      "SELECT g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.member_id = ? ORDER BY gm.joined_at",
    ).bind(them.id).all();
    return { name: them.name, by: by?.name || null, wishes: wishes[0]?.n || 0, circles: circles.map((c) => c.name) };
  },

  // Use a personal invite link: the list becomes theirs, they're signed in on this device, and they get the
  // welcome tour (which offers a PIN). The link stops working. { token }
  async "POST claim"(req, env) {
    const b = await body(req);
    await rateLimit(env, `join:ip:${ipOf(req)}`, ABUSE.joinPerIp, "Too many sign-in tries. Wait a bit and try again.");
    const them = await claimFor(env, b.token);
    const done = await env.DB.prepare(
      "UPDATE members SET managed_by = NULL, claim_hash = NULL, claim_expires = NULL, onboarded_at = NULL WHERE id = ? AND claim_hash IS NOT NULL",
    ).bind(them.id).run();
    if (!done.meta?.changes) fail(404, "That invite link was already used.");
    return { token: await signIn(env, them.id), name: them.name };
  },

  // Take someone you look after out of every circle (and their household). Nobody can see their list after that.
  async "POST managed/remove"(req, env) {
    const me = await auth(req, env);
    const { memberId } = await body(req);
    if (!(await canManage(env, me.id, memberId))) fail(404, "Person not found.");
    const id = String(memberId);
    await leaveHousehold(env, id);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM item_hidden WHERE item_id IN (SELECT id FROM items WHERE owner_id = ?)").bind(id),
      env.DB.prepare("DELETE FROM group_members WHERE member_id = ?").bind(id),
      env.DB.prepare("DELETE FROM devices WHERE member_id = ?").bind(id),
    ]);
    return { ok: true };
  },

  // ---------- households ----------
  // You can always organize your own household. A circle's admin can also organize any household with
  // someone in that circle. Every action takes an optional householdId; without one it's your own household.

  // Make a household out of people in one of your circles, and put it in that circle.
  async "POST household/create"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const groupId = b.groupId;
    if (!(await myGroupIds(env, me.id)).includes(groupId)) fail(404, "Circle not found.");
    if ((await adminOf(env, groupId)) !== me.id) fail(403, "Only the circle's admin can make households here.");
    const ids = [...new Set((Array.isArray(b.memberIds) ? b.memberIds : []).map(String))];
    if (!ids.length) fail(400, "Pick who's in the household.");
    if (ids.length > 30) fail(400, "That's a lot of people for one household.");
    const name = text(b.name, LIMITS.household, "Household name");
    for (const id of ids) {
      const row = await env.DB.prepare(
        "SELECT m.name, m.household_id FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND m.id = ?",
      ).bind(groupId, id).first();
      if (!row) fail(404, "Someone you picked isn't in this circle.");
      if (row.household_id) fail(409, `${row.name} is already in a household. Take them out of it first.`);
    }
    const hh = newId();
    const t = now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)").bind(hh, name, t),
      env.DB.prepare("INSERT INTO group_households (group_id, household_id, added_at) VALUES (?, ?, ?)").bind(groupId, hh, t),
      ...ids.map((id) => env.DB.prepare("UPDATE members SET household_id = ? WHERE id = ?").bind(hh, id)),
    ]);
    return { household: { id: hh } };
  },

  // Set up a household of people who aren't on Hints yet, in a circle you're the admin of. Each one is someone
  // you look after (managed) until they open their personal invite link. { groupId, name?, people: [names] }
  async "POST household/new"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const groupId = b.groupId;
    if (!(await myGroupIds(env, me.id)).includes(groupId)) fail(404, "Circle not found.");
    if ((await adminOf(env, groupId)) !== me.id) fail(403, "Only the circle's admin can set up households here.");
    const hhName = text(b.name, LIMITS.household, "Household name");
    // people: [{ name, lastName? }]. It's a new household, so only two of the same name in this list clash.
    const ppl = (Array.isArray(b.people) ? b.people : [])
      .map((p) => ({ name: text(p?.name, LIMITS.name, "First name"), lastName: text(p?.lastName, LIMITS.lastName, "Last name") }))
      .filter((p) => p.name || p.lastName);
    if (!ppl.length) fail(400, "Add at least one person.");
    if (ppl.length > 12) fail(400, "That's a lot of people for one household.");
    for (const p of ppl) if (!p.name) fail(400, `Add a first name for ${p.lastName}.`);
    const names = ppl.map((p) => p.name);
    const keys = ppl.map((p) => `${p.name}\n${p.lastName || ""}`.toLowerCase());
    const dupe = ppl.find((p, i) => keys.indexOf(keys[i]) !== i);
    if (dupe) fail(409, dupe.lastName ? `${dupe.name} ${dupe.lastName} is in the list twice.` : `${dupe.name} is in the list twice. Add a last name to tell them apart.`);
    await circleRoom(env, groupId, names.length);
    const { n: managedCount } = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE managed_by = ?").bind(me.id).first();
    if (managedCount + names.length > ABUSE.managedPerMember) fail(409, `You can set up ${ABUSE.managedPerMember} people at a time. Send some invites first.`);
    for (let i = 0; i < names.length; i++) await rateLimit(env, `managed:${me.id}`, ABUSE.managedAddsPerMemberDay, "That's a lot of new people today. Try again tomorrow.");
    if ((await hit(env, "newmember:all", 86400)) > ABUSE.newMembersPerDay) fail(429, "Hints isn't taking new people right now. Try again tomorrow.");
    const hh = newId();
    const t = now();
    const ids = names.map(() => newId());
    await env.DB.batch([
      env.DB.prepare("INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)").bind(hh, hhName, t),
      env.DB.prepare("INSERT INTO group_households (group_id, household_id, added_at) VALUES (?, ?, ?)").bind(groupId, hh, t),
      ...ppl.flatMap((p, i) => [
        env.DB.prepare("INSERT INTO members (id, name, last_name, created_at, managed_by, household_id, onboarded_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(ids[i], p.name, p.lastName, t, me.id, hh, t),
        env.DB.prepare("INSERT INTO group_members (group_id, member_id, joined_at, direct) VALUES (?, ?, ?, 0)").bind(groupId, ids[i], t),
      ]),
    ]);
    return { household: { id: hh }, people: names.map((n, i) => ({ id: ids[i], name: n })) };
  },

  // Add someone you share a circle with to a household (yours by default, starting one if you don't have one).
  // They join every circle the household is in.
  async "POST household/add"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const memberId = b.memberId;
    if (!memberId) fail(400, "Pick someone to add.");
    if (!(await sharesGroup(env, me.id, memberId))) fail(404, "Person not found.");
    const them = await env.DB.prepare("SELECT name, household_id FROM members WHERE id = ?").bind(memberId).first();
    if (!them) fail(404, "Person not found.");
    let hh = b.householdId ? await manageableHousehold(env, me.id, b.householdId) : await householdOf(env, me.id);
    if (them.household_id && them.household_id === hh) fail(409, `${them.name} is already in this household.`);
    if (them.household_id) fail(409, `${them.name} is already in another household. Take them out of it first.`);
    if (!hh && memberId === me.id) fail(400, "Pick someone to add.");
    const t = now();
    if (!hh) {
      hh = newId();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO households (id, name, created_at) VALUES (?, NULL, ?)").bind(hh, t),
        env.DB.prepare("UPDATE members SET household_id = ? WHERE id = ?").bind(hh, me.id),
      ]);
    }
    const { results } = await env.DB.prepare("SELECT group_id FROM group_households WHERE household_id = ?").bind(hh).all();
    const clash = await nameClash(env, results.map((r) => r.group_id), [memberId], hh);
    if (clash) fail(409, `Someone named ${them.name} with the same last name is already in ${clash}, which this household is in.`);
    for (const r of results) {
      const inIt = await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND member_id = ?").bind(r.group_id, memberId).first();
      if (!inIt) await circleRoom(env, r.group_id);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET household_id = ? WHERE id = ?").bind(hh, memberId),
      env.DB.prepare(
        "INSERT INTO group_members (group_id, member_id, joined_at, direct) SELECT group_id, ?, ?, 0 FROM group_households WHERE household_id = ? ON CONFLICT DO NOTHING",
      ).bind(memberId, t, hh),
    ]);
    return { ok: true };
  },

  // Take someone out of a household (yours by default), or yourself (leave it). They drop out of circles
  // they were only in through the household. A household nobody is left in goes away.
  async "POST household/remove"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const memberId = b.memberId || me.id;
    const hh = b.householdId ? await manageableHousehold(env, me.id, b.householdId) : await householdOf(env, me.id);
    if (!hh || (await householdOf(env, memberId)) !== hh) fail(404, "They aren't in that household.");
    // Someone who doesn't use the app can't rejoin a circle themselves, so they keep the ones they're in.
    if (memberId !== me.id && (await canManage(env, me.id, memberId))) {
      await env.DB.prepare("UPDATE group_members SET direct = 1 WHERE member_id = ?").bind(String(memberId)).run();
    }
    await leaveHousehold(env, memberId);
    return { ok: true };
  },

  // Name a household (yours by default). "" goes back to the automatic name from its people.
  async "POST household/rename"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const hh = b.householdId ? await manageableHousehold(env, me.id, b.householdId) : await householdOf(env, me.id);
    if (!hh) fail(404, "You're not in a household.");
    const name = text(b.name, LIMITS.household, "Household name");
    await env.DB.prepare("UPDATE households SET name = ? WHERE id = ?").bind(name, hh).run();
    return { ok: true };
  },

  // Set or remove a household's photo (yours by default). "" removes it.
  async "POST household/photo"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const hh = b.householdId ? await manageableHousehold(env, me.id, b.householdId) : await householdOf(env, me.id);
    if (!hh) fail(404, "You're not in a household.");
    const photo = photoValue(b.photo);
    await env.DB.prepare("UPDATE households SET photo = ?, photo_at = ? WHERE id = ?").bind(photo, photo ? now() : null, hh).run();
    return { ok: true };
  },

  // Put a whole household (yours by default) in one of your circles (on), or take it out (off). In: everyone
  // in it, including people added later. Out: people who were only there through the household leave that circle.
  async "POST household/circle"(req, env) {
    const me = await auth(req, env);
    const { groupId, on, householdId } = await body(req);
    const hh = householdId ? await manageableHousehold(env, me.id, householdId) : await householdOf(env, me.id);
    if (!hh) fail(404, "You're not in a household.");
    if (!(await myGroupIds(env, me.id)).includes(groupId)) fail(404, "Circle not found.");
    // Someone else's household (managed as a circle's admin) can only be moved in or out of a circle you're the admin of,
    // so an admin of one circle can't pull other people into a different circle.
    if (hh !== (await householdOf(env, me.id)) && (await adminOf(env, groupId)) !== me.id) fail(403, "Only that circle's admin can do that.");
    const { results: ppl } = await env.DB.prepare("SELECT id FROM members WHERE household_id = ?").bind(hh).all();
    const ids = ppl.map((p) => p.id);
    const t = now();
    if (on) {
      const { n: already } = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND m.household_id = ?",
      ).bind(groupId, hh).first();
      await circleRoom(env, groupId, ids.length - already);
      const clash = await nameClash(env, [groupId], ids, hh);
      if (clash) fail(409, `Someone in that household has the same name as someone already in ${clash}. One of them can add their last name first.`);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO group_households (group_id, household_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(groupId, hh, t),
        ...ids.map((id) => env.DB.prepare(
          "INSERT INTO group_members (group_id, member_id, joined_at, direct) VALUES (?, ?, ?, 0) ON CONFLICT DO NOTHING",
        ).bind(groupId, id, t)),
      ]);
    } else {
      const rows = [env.DB.prepare("DELETE FROM group_households WHERE group_id = ? AND household_id = ?").bind(groupId, hh)];
      for (const id of ids) rows.push(...(await dropViaHousehold(env, id, groupId)));
      await env.DB.batch(rows);
    }
    return { ok: true };
  },

  // Change your name, PIN, photo and/or profile. pin: "1234" sets it, "" removes it, absent leaves it alone.
  // photo: a small JPEG data URL (the app resizes it to a square first), "" removes it, absent leaves it alone.
  // birthday: "MM-DD" or "" to clear (no year; ages are never kept). sizes: { shirt, pants, shoe, ring }. avoid: free text.
  // brands: favorite brand names (free text). giftStyle: up to 5 keys ("surprise" and "list" not together). colors, colorsNo: any color keys (favorites and
  // colors to skip; one color can't be both, favorites win). loves: short free text (old).
  // likes, dislikes: lists of short tags (Loves and Nopes). bio: one short line.
  // as: someone you look after (everything but the PIN). Absent = unchanged.
  async "POST profile"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    // as: someone you look after. Their PIN is never set from here (they don't sign in).
    const who = await ownerFor(env, me, b.as);
    if (who !== me.id && b.pin !== undefined) fail(400, "Only they can set their own PIN.");
    // Name and optional last name. Nobody in their circles and their household slot may end up with the same name.
    if (b.name !== undefined || b.lastName !== undefined) {
      const row = await env.DB.prepare("SELECT name, last_name, household_id FROM members WHERE id = ?").bind(who).first();
      const first = b.name !== undefined ? text(b.name, LIMITS.name, "Name", true) : row.name;
      const last = b.lastName !== undefined ? lastNameOf(b.lastName) : row.last_name;
      const clash = await env.DB.prepare(
        `SELECT g.name FROM group_members gm JOIN members m ON m.id = gm.member_id JOIN groups g ON g.id = gm.group_id
          WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_id = ?) AND m.id != ? AND ${SAME_SLOT} LIMIT 1`,
      ).bind(who, who, first, last, row.household_id).first();
      if (clash) fail(409, clashMsg(first, last, clash.name));
      await env.DB.prepare("UPDATE members SET name = ?, last_name = ? WHERE id = ?").bind(first, last, who).run();
    }
    if (b.birthday !== undefined) {
      const before = await env.DB.prepare("SELECT birthday FROM members WHERE id = ?").bind(who).first();
      const birthday = birthdayValue(b.birthday);
      const after = { birthday };
      const oldBday = occasionsFor(before).find((o) => o.birthday && !o.christmas)?.code;
      const next = occasionsFor(after);
      const newCode = (next.find((o) => o.birthday) || next.find((o) => o.christmas)).code;
      const rows = [env.DB.prepare("UPDATE members SET birthday = ? WHERE id = ?").bind(birthday, who)];
      // Budgets and marks family filed for your upcoming birthday follow it to the new date (or to Christmas
      // if you removed it). You never see them; this just keeps their plans together.
      if (oldBday && oldBday !== newCode) {
        rows.push(
          env.DB.prepare("UPDATE OR IGNORE budgets SET season = ? WHERE subject_id = ? AND season = ?").bind(newCode, who, oldBday),
          // Someone who already had a budget for the new date keeps that one.
          env.DB.prepare("DELETE FROM budgets WHERE subject_id = ? AND season = ?").bind(who, oldBday),
          env.DB.prepare("UPDATE OR IGNORE household_budgets SET season = ? WHERE target = ? AND season = ?").bind(newCode, `m:${who}`, oldBday),
          env.DB.prepare("DELETE FROM household_budgets WHERE target = ? AND season = ?").bind(`m:${who}`, oldBday),
          env.DB.prepare("UPDATE OR IGNORE claims SET season = ? WHERE season = ? AND item_id IN (SELECT id FROM items WHERE owner_id = ?)").bind(newCode, oldBday, who),
          env.DB.prepare("UPDATE OR IGNORE idea_claims SET season = ? WHERE season = ? AND idea_id IN (SELECT id FROM private_ideas WHERE subject_id = ?)").bind(newCode, oldBday, who),
          env.DB.prepare("UPDATE OR IGNORE gift_card_gifts SET season = ? WHERE member_id = ? AND season = ?").bind(newCode, who, oldBday),
        );
      }
      await env.DB.batch(rows);
    }
    if (b.sizes !== undefined) {
      const src = b.sizes && typeof b.sizes === "object" ? b.sizes : {};
      const sizes = Object.fromEntries(SIZE_KEYS.map((k) => [k, text(src[k], LIMITS.size, "Size") || ""]).filter(([, v]) => v));
      const value = Object.keys(sizes).length ? JSON.stringify(sizes) : null;
      // Only a real change counts as "updated" (saving the profile without touching sizes doesn't), unless
      // sizesChecked says someone looked and they're still right.
      await env.DB.prepare("UPDATE members SET sizes = ?1, sizes_at = CASE WHEN ?1 IS NULL THEN NULL WHEN ?4 = 1 OR IFNULL(sizes, '') != ?1 THEN ?2 ELSE sizes_at END WHERE id = ?3")
        .bind(value, now(), who, b.sizesChecked ? 1 : 0).run();
    }
    if (b.avoid !== undefined) {
      await env.DB.prepare("UPDATE members SET avoid = ? WHERE id = ?").bind(text(b.avoid, LIMITS.avoid, "Dislikes and allergies"), who).run();
    }
    if (b.brands !== undefined) {
      const seen = new Set(), brands = [];
      for (const v of Array.isArray(b.brands) ? b.brands : []) {
        const name = text(typeof v === "string" ? v.replace(/\s+/g, " ") : "", LIMITS.brand, "Brand name");
        if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); brands.push(name); }
      }
      if (brands.length > LIMITS.brands) fail(400, `That's a lot of brands. Keep it to ${LIMITS.brands}.`);
      await env.DB.prepare("UPDATE members SET brands = ? WHERE id = ?").bind(brands.length ? JSON.stringify(brands) : null, who).run();
    }
    if (b.giftStyle !== undefined) {
      const styles = keysIn(b.giftStyle, GIFT_STYLES, GIFT_STYLE_MAX);
      if (styles?.includes('"surprise"') && styles.includes('"list"')) fail(400, "Pick Surprise me or Stick to my list, not both.");
      await env.DB.prepare("UPDATE members SET gift_style = ? WHERE id = ?").bind(styles, who).run();
    }
    if (b.colors !== undefined || b.colorsNo !== undefined) {
      const row = await env.DB.prepare("SELECT colors, colors_no FROM members WHERE id = ?").bind(who).first();
      const all = FAV_COLORS.length;
      const fav = b.colors !== undefined ? JSON.parse(keysIn(b.colors, FAV_COLORS, all) || "[]") : keysOut(row?.colors, FAV_COLORS, all);
      const no = (b.colorsNo !== undefined ? JSON.parse(keysIn(b.colorsNo, FAV_COLORS, all) || "[]") : keysOut(row?.colors_no, FAV_COLORS, all)).filter((k) => !fav.includes(k));
      await env.DB.prepare("UPDATE members SET colors = ?, colors_no = ? WHERE id = ?")
        .bind(fav.length ? JSON.stringify(fav) : null, no.length ? JSON.stringify(no) : null, who).run();
    }
    if (b.metals !== undefined) {
      const metals = METALS.filter((k) => (Array.isArray(b.metals) ? b.metals.map(String) : []).includes(k));
      await env.DB.prepare("UPDATE members SET metals = ? WHERE id = ?").bind(metals.length ? JSON.stringify(metals) : null, who).run();
    }
    if (b.mixedMetals !== undefined) {
      await env.DB.prepare("UPDATE members SET mixed_metals = ? WHERE id = ?").bind(b.mixedMetals ? 1 : 0, who).run();
    }
    if (b.likes !== undefined || b.dislikes !== undefined) {
      const likes = b.likes !== undefined ? tagsIn(b.likes, "Loves") : undefined;
      const dislikes = b.dislikes !== undefined ? tagsIn(b.dislikes, "Nopes") : undefined;
      const both = new Set([...JSON.parse(likes || "[]"), ...JSON.parse(dislikes || "[]")].map((t) => t.toLowerCase()));
      if (likes && dislikes && both.size < JSON.parse(likes).length + JSON.parse(dislikes).length) fail(400, "Something is in both Loves and Nopes. Pick one.");
      // Saving likes replaces the old free-text loves for good.
      if (likes !== undefined) await env.DB.prepare("UPDATE members SET likes = ?, loves = NULL WHERE id = ?").bind(likes || "[]", who).run();
      if (dislikes !== undefined) await env.DB.prepare("UPDATE members SET dislikes = ? WHERE id = ?").bind(dislikes, who).run();
    }
    if (b.kid !== undefined) {
      await env.DB.prepare("UPDATE members SET is_kid = ? WHERE id = ?").bind(b.kid ? 1 : 0, who).run();
    }
    if (b.owns !== undefined) {
      await env.DB.prepare("UPDATE members SET owns = ? WHERE id = ?").bind(tagsIn(b.owns, "Already has"), who).run();
    }
    if (b.bio !== undefined) {
      await env.DB.prepare("UPDATE members SET bio = ? WHERE id = ?").bind(text(b.bio, LIMITS.bio, "Bio") || null, who).run();
    }
    if (b.loves !== undefined) {
      await env.DB.prepare("UPDATE members SET loves = ? WHERE id = ?").bind(text(b.loves, LIMITS.loves, "Little things you love") || null, who).run();
    }
    if (b.pin !== undefined) {
      const pin = pinValue(b.pin);
      await env.DB.prepare("UPDATE members SET pin_hash = ?, pin_cleared_by = NULL, pin_cleared_at = NULL WHERE id = ?")
        .bind(pin ? await hashPin(who, pin) : null, who)
        .run();
    }
    if (b.photo !== undefined) {
      const photo = photoValue(b.photo);
      await env.DB.prepare("UPDATE members SET photo = ?, photo_at = ? WHERE id = ?").bind(photo, photo ? now() : null, who).run();
    }
    return { ok: true };
  },

  // Clear someone's forgotten PIN so they can sign in again. There's no email to reset it with, so someone who
  // knows them vouches instead: anyone in their household, or the admin of a circle they're in. They see who did
  // it the next time they open the app (members.pin_cleared_by, migration 0024). Your own PIN is in POST profile.
  async "POST pin/clear"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const id = String(b.memberId || "");
    if (!id || id === me.id) fail(400, "Change your own PIN in Settings.");
    const them = await env.DB.prepare("SELECT id, pin_hash, household_id FROM members WHERE id = ?").bind(id).first();
    if (!them) fail(404, "Person not found.");
    const myHh = await householdOf(env, me.id);
    let ok = !!myHh && them.household_id === myHh;
    if (!ok) {
      const { results } = await env.DB.prepare(
        "SELECT a.group_id FROM group_members a JOIN group_members b ON b.group_id = a.group_id WHERE a.member_id = ? AND b.member_id = ?",
      ).bind(id, me.id).all();
      if (!results.length) fail(404, "Person not found.");
      for (const r of results) if ((await adminOf(env, r.group_id)) === me.id) { ok = true; break; }
    }
    if (!ok) fail(403, "Only someone in their household or their circle's admin can clear their PIN.");
    if (!them.pin_hash) return { ok: true };
    await env.DB.prepare("UPDATE members SET pin_hash = NULL, pin_cleared_by = ?, pin_cleared_at = ? WHERE id = ?")
      .bind(me.id, now(), id)
      .run();
    return { ok: true };
  },

  // Dismiss the "your PIN was cleared" notice without setting a new PIN.
  async "POST pin/seen"(req, env) {
    const me = await auth(req, env);
    await env.DB.prepare("UPDATE members SET pin_cleared_by = NULL, pin_cleared_at = NULL WHERE id = ?").bind(me.id).run();
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
  // ?m= a person, ?g= a circle, ?h= a household.
  async "GET photo"(req, env, url) {
    const q = url.searchParams;
    const [table, id] = q.has("g") ? ["groups", q.get("g")] : q.has("h") ? ["households", q.get("h")] : ["members", q.get("m")];
    const row = await env.DB.prepare(`SELECT photo FROM ${table} WHERE id = ?`).bind(id || "").first();
    const m = row?.photo && PHOTO_RE.exec(row.photo);
    if (!m) return new Response("Not found", { status: 404 });
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { "content-type": `image/${m[1]}`, "cache-control": "public, max-age=31536000, immutable" } });
  },

  async "POST signout"(req, env) {
    const me = await auth(req, env);
    // This device's notifications end with its sign-in, so the next person on it never gets yours.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM push_subs WHERE device_token = ?").bind(me.token),
      env.DB.prepare("DELETE FROM devices WHERE token = ?").bind(me.token),
    ]);
    return { ok: true };
  },
};

async function handle(request, env, key, ctx) {
  if (!env.DB) return json({ error: "Hints database isn't set up yet (missing DB binding)." }, 500);
  try {
    const out = await handlers[key](request, env, new URL(request.url), ctx);
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
    (request, env, ctx) => {
      const key = byMethod[request.method];
      return key ? handle(request, env, key, ctx) : json({ error: "Method not allowed." }, 405);
    },
  ]),
);
