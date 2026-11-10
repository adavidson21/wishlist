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
import { LIMITS as ABUSE, hit, peek, ipOf, scope } from "./limits.js";
import { sendPush, vapidKeys, pushEndpointOk } from "./push.js";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
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
// A profile cover (wider, so a bit bigger than a photo), or null to remove it.
const MAX_COVER = 250_000;
function coverValue(v) {
  const cover = v ? String(v) : null;
  if (cover && (cover.length > MAX_COVER || !PHOTO_RE.test(cover))) fail(400, "That cover photo didn't work. Try another one.");
  return cover;
}
const LIMITS = { chat: 500, tag: 40, tags: 30, bio: 100, stash: 80, color: 40, household: 40, loves: 200, nickname: 40, name: 40, lastName: 40, size: 30, avoid: 300, brand: 40, brands: 20, giftCards: 60, group: 60, petName: 40, petNotes: 200, title: 200, url: 2000, notes: 1000 };
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

// PINs. The base hash is SHA-256 of the member id and PIN. With only 10,000 PINs that alone is no protection if
// the database or a backup ever leaked, so once PIN_PEPPER is set (a Worker secret, never in D1 or backups) the
// stored hash is "p1:" + HMAC-SHA256(PIN_PEPPER, base hash). Wrapping the base hash (not the PIN) means old
// hashes are upgraded without anyone's PIN: the hourly schedule does it (pepperPins), and checkPin accepts both.
// Never change or remove PIN_PEPPER once set: every wrapped PIN would stop matching.
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
async function basePinHash(memberId, pin) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`wishlist:${memberId}:${pin}`)));
}
async function pepperHash(env, base) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.PIN_PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `p1:${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)))}`;
}
async function hashPin(env, memberId, pin) {
  const base = await basePinHash(memberId, pin);
  return env.PIN_PEPPER ? pepperHash(env, base) : base;
}
// Same length strings compared without stopping at the first difference.
function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function pinMatches(env, member, pin) {
  const base = await basePinHash(member.id, pin);
  const stored = member.pin_hash || "";
  if (!stored.startsWith("p1:")) return sameHash(base, stored);
  if (!env.PIN_PEPPER) fail(503, "PIN sign-in isn't working right now. Try again later.");
  return sameHash(await pepperHash(env, base), stored);
}
// Hourly: wraps PIN hashes made before PIN_PEPPER was set (a few hundred per run).
async function pepperPins(env) {
  if (!env.PIN_PEPPER) return;
  const { results } = await env.DB.prepare("SELECT id, pin_hash FROM members WHERE pin_hash IS NOT NULL AND pin_hash NOT LIKE 'p1:%' LIMIT 300").all();
  if (!results.length) return;
  await env.DB.batch(await Promise.all(results.map(async (r) =>
    env.DB.prepare("UPDATE members SET pin_hash = ? WHERE id = ? AND pin_hash = ?").bind(await pepperHash(env, r.pin_hash), r.id, r.pin_hash))));
  console.log(`peppered ${results.length} PIN hashes`);
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
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra; // more fields for the JSON answer (e.g. { turnstile: siteKey })
  }
}
const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
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
// On top of that (docs/plans/public-launch.md):
//   - A few wrong PINs for one person: they get "Someone tried to sign in as you" on their signed-in devices.
//   - Lots of wrong PINs across the whole app in an hour (someone trying a few PINs on everyone): "lockdown" for
//     the rest of the hour, 3 tries per person, and whoever runs Hints gets a push.
//   - With Turnstile set up (TURNSTILE_SITE_KEY var + TURNSTILE_SECRET secret), a person with recent misses, or
//     anyone during lockdown, must pass a Turnstile check first. Without it, everything else still applies.
async function checkPin(env, request, member, pin, turnstileToken) {
  const tooMany = "Too many PIN tries. Wait a while and try again.";
  const lockdown = (await peek(env, "pinmiss:all", 3600)) >= ABUSE.pinMissesPerHour;
  if (turnstileOn(env) && (lockdown || (await peek(env, `pinmiss:m:${member.id}`, 900)) >= ABUSE.pinMissesWarn)) {
    await turnstileCheck(env, request, turnstileToken);
  }
  await rateLimit(env, `pin:m:${member.id}`, lockdown ? [...ABUSE.pinTriesPerMember, ...ABUSE.pinTriesLockdown] : ABUSE.pinTriesPerMember, tooMany);
  await rateLimit(env, `pin:ip:${ipOf(request)}`, ABUSE.pinTriesPerIp, tooMany);
  if (!pin) fail(403, "PIN required.");
  if (!(await pinMatches(env, member, String(pin)))) {
    await pinMissed(env, member);
    fail(403, "Wrong PIN.");
  }
}
async function pinMissed(env, member) {
  const [mine, all] = await Promise.all([hit(env, `pinmiss:m:${member.id}`, 900), hit(env, "pinmiss:all", 3600)]);
  const jobs = [];
  // Once per hour per person, on their own devices (held for quiet hours like any other push).
  if (mine >= ABUSE.pinMissesWarn && (await hit(env, `pinwarn:m:${member.id}`, 3600)) === 1) {
    jobs.push(pushTo(env, member.id, {
      title: "Someone tried to sign in as you",
      body: "A few wrong PINs just now. Your PIN kept them out. Wasn't you? You can change it in Settings.",
      url: "/#settings", tag: "pinwarn",
    }));
  }
  if (all === ABUSE.pinMissesPerHour) {
    const owner = await appOwner(env).catch(() => null);
    if (owner) jobs.push(pushTo(env, owner, {
      title: "Lots of wrong PINs on Hints",
      body: `${all} wrong PINs in the last hour. Sign-in is tightened up for the rest of the hour.`,
      url: "/#settings", tag: "pinlockdown",
    }, { anyTime: true }));
  }
  await Promise.all(jobs).catch((err) => console.error("pin warn", err));
}
// Cloudflare Turnstile (free bot check), only when both keys are set.
const turnstileOn = (env) => !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
async function turnstileCheck(env, request, token) {
  const ask = (msg) => fail(403, msg, { turnstile: env.TURNSTILE_SITE_KEY });
  if (!token || typeof token !== "string" || token.length > 2048) ask("Quick check first, then try your PIN again.");
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", request.headers.get("cf-connecting-ip") || "");
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })
    .then((x) => x.json()).catch(() => null);
  // Turnstile itself being down shouldn't lock everyone out: the try limits still apply.
  if (r === null) return;
  if (!r.success) ask("That check didn't go through. Try again.");
}

// Signing in as someone with no PIN yet (their name on the circle link, or their personal link). Allowed only when
// nobody is signed in as them anywhere, or someone they trust cleared their forgotten PIN; either way they pick a
// PIN now. Otherwise anyone holding the link could become them.
async function setFirstPin(env, request, member, pinIn) {
  const elsewhere = await env.DB.prepare("SELECT 1 FROM devices WHERE member_id = ? LIMIT 1").bind(member.id).first();
  if (elsewhere && !member.pin_cleared_at) {
    fail(423, `${member.name} is already signed in on another phone or computer. Open Hints there and set a PIN (Hints asks for one), then come back and tap your name.`);
  }
  const pin = pinValue(pinIn);
  if (!pin) fail(428, "Pick a 4-digit PIN so only you can sign in as you.");
  await rateLimit(env, `pin:m:${member.id}`, ABUSE.pinTriesPerMember, "Too many PIN tries. Wait a while and try again.");
  await env.DB.prepare("UPDATE members SET pin_hash = ?, pin_cleared_by = NULL, pin_cleared_at = NULL WHERE id = ? AND pin_hash IS NULL")
    .bind(await hashPin(env, member.id, pin), member.id).run();
}
// Someone asked to join a circle with Ask to join on: tell its admin.
async function askedToJoin(env, group, name) {
  const admin = await adminOf(env, group.id);
  if (!admin) return;
  await pushTo(env, admin, { title: `${name} wants to join ${group.name}`, body: "Tap to let them in.", url: "/#family", tag: `join:${group.id}` })
    .catch((err) => console.error("join push", err));
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
// price_auto: 0 typed by hand, 1 synced from the store, 2 synced but only an estimate (converted from another
// currency, or from a search instead of the page). The app shows 2 as "~$X" and asks the owner to check it.
const priceAuto = (b, fields) => (b.priceAuto && fields[1] && fields[2] != null ? (b.priceAuto === "guess" ? 2 : 1) : 0);

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
// Records who this request is for (Gemini allowances, src/limits.js).
function forScope(member) {
  const s = scope.getStore();
  if (s) s.member = { id: member.id, createdAt: member.created_at };
}
async function auth(request, env) {
  const token = request.headers.get("x-wishlist-token");
  if (!token) fail(401, "Not signed in.");
  const me = await env.DB.prepare(
    "SELECT m.id, m.name, m.last_name, m.pin_hash, m.onboarded_at, m.pin_cleared_by, m.pin_cleared_at, m.created_at FROM devices d JOIN members m ON m.id = d.member_id WHERE d.token = ?",
  )
    .bind(token)
    .first();
  if (!me) fail(401, "Signed out. Open your invite or sign-in link again.");
  forScope(me);
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
    // Cover photo's version (migration 0039), or null for the favorite-colors cover. Served by GET photo?c=<member id>.
    cover: row?.cover_at || null,
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
const ITEM_VISIBLE = `i.draft = 0 AND i.held_season IS NULL AND i.received_at IS NULL AND EXISTS (
  SELECT 1 FROM group_members x JOIN group_members y ON y.group_id = x.group_id
   WHERE x.member_id = ? AND y.member_id = i.owner_id
     AND NOT EXISTS (SELECT 1 FROM item_hidden h WHERE h.item_id = i.id AND h.group_id = x.group_id))`;

// ---------- linked wishes ("Goes with") ----------
// bundle_id: wishes that share one are all or nothing. needs_id: only wanted along with that wish (one way).
// rows: all of an owner's items (id, title, draft, bundle_id, needs_id, removed_at, held_season, received_at).
// shown: ids the viewer can see, or null for the owner (sees everything, nothing is blocked).
// A partner that's held or received is already being given, so it no longer holds anything back.
// Returns blocked (ids to keep from this viewer: a partner they can't see, or a needed wish that was removed)
// and links (id -> [{ id, title, kind }], kind together | needs | pairs, where pairs = only wanted with this one).
function linkInfo(rows, shown) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const done = (r) => !!(r.held_season || r.received_at);
  const live = (r) => r && !r.removed_at && !done(r);
  const sees = (r) => !shown || shown.has(r.id);
  const blocked = new Set();
  const partners = (r) => (r.bundle_id ? rows.filter((o) => o.id !== r.id && o.bundle_id === r.bundle_id && live(o)) : []);
  if (shown) for (const r of rows) {
    if (!live(r)) continue;
    if (partners(r).some((o) => !sees(o))) blocked.add(r.id);
    if (r.needs_id) {
      const t = byId.get(r.needs_id);
      if (!t || (t.removed_at && !done(t)) || (live(t) && !sees(t))) blocked.add(r.id);
    }
  }
  const ok = (o) => sees(o) && !blocked.has(o.id);
  const out = (o, kind) => ({ id: o.id, title: o.title, kind, ...(shown ? {} : { draft: !!o.draft }) });
  const links = new Map();
  for (const r of rows) {
    if (!live(r)) continue;
    const l = partners(r).filter(ok).map((o) => out(o, "together"));
    if (r.needs_id) {
      const t = byId.get(r.needs_id);
      if (live(t) && ok(t)) l.push(out(t, "needs"));
      else if (!shown && (!t || t.removed_at)) l.push({ id: r.needs_id, title: t?.title || "", kind: "needs", removed: true });
    }
    for (const o of rows) if (o.needs_id === r.id && live(o) && ok(o)) l.push(out(o, "pairs"));
    if (l.length) links.set(r.id, l);
  }
  return { blocked, links };
}
const LINK_COLS = "id, title, draft, bundle_id, needs_id, removed_at, held_season, received_at";
// Drop a bundle that's down to one wish (it has nothing left to go with).
const bundleCleanup = (env, bundleId) =>
  env.DB.prepare("UPDATE items SET bundle_id = NULL WHERE bundle_id = ?1 AND (SELECT COUNT(*) FROM items WHERE bundle_id = ?1 AND removed_at IS NULL) < 2").bind(bundleId);

// ---------- received wishes ----------
// Once an occasion passes, a wish marked for it is held (held_season) until its owner answers "Did you get
// this?": received, or settled (back on the list, not asked again for that occasion). Held wishes leave
// everyone's shopping view (ITEM_VISIBLE). "As many as you like" wishes are never held. A wish held for 30 days
// is received. Runs hourly (runSchedule) and when an owner opens their list. ownerId limits it to one person.
const RECEIVE_AFTER_DAYS = 30;
function codeDaysAgo(n) {
  const t = todayParts();
  const d = new Date(Date.UTC(t.y, t.m - 1, t.d - n));
  return dateCode(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
async function settleReceived(env, ownerId = null) {
  const t = today();
  const who = ownerId ? "AND items.owner_id = ?2" : "";
  const args = ownerId ? [t, ownerId] : [t];
  const past = "SELECT MAX(c.season) FROM claims c WHERE c.item_id = items.id AND c.season < ?1 AND c.season > COALESCE(items.settled_season, 0)";
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE items SET held_season = (${past})
        WHERE held_season IS NULL AND received_at IS NULL AND removed_at IS NULL AND draft = 0 AND quantity != 0 ${who}
          AND (${past}) IS NOT NULL`,
    ).bind(...args),
    env.DB.prepare(
      `UPDATE items SET received_at = ?, received_season = held_season, settled_season = held_season, held_season = NULL
        WHERE held_season IS NOT NULL AND held_season < ? ${ownerId ? "AND owner_id = ?" : ""}`,
    ).bind(now(), codeDaysAgo(RECEIVE_AFTER_DAYS), ...(ownerId ? [ownerId] : [])),
  ]);
}

// ---------- gift history ----------
// Purchases for occasions that have passed, copied into gift_history (migration 0035) so they outlive edits and
// deletes. Spent follows the tracker: what you paid, else the listed price (times how many), and a group gift
// share counts only what you entered. Runs hourly and right before a wish or idea is deleted.
async function snapshotGifts(env) {
  const t = today(), at = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO gift_history (buyer_id, subject_id, season, kind, ref_id, title, url, image_url, spent_cents, qty, chip_in, created_at)
       SELECT c.buyer_id, i.owner_id, c.season, 'item', i.id, i.title, i.url, i.image_url,
              COALESCE(c.price_cents, CASE WHEN c.chip_in = 1 THEN 0 ELSE COALESCE(i.price_cents, 0) * COALESCE(c.qty, 1) END), COALESCE(c.qty, 1), c.chip_in, ?
         FROM claims c JOIN items i ON i.id = c.item_id WHERE c.season < ?`,
    ).bind(at, t),
    env.DB.prepare(
      `INSERT OR IGNORE INTO gift_history (buyer_id, subject_id, season, kind, ref_id, title, url, image_url, spent_cents, created_at)
       SELECT c.buyer_id, p.subject_id, c.season, 'idea', p.id, p.title, p.url, p.image_url, COALESCE(c.price_cents, p.price_cents, 0), ?
         FROM idea_claims c JOIN private_ideas p ON p.id = c.idea_id WHERE c.season < ?`,
    ).bind(at, t),
    env.DB.prepare(
      `INSERT OR IGNORE INTO gift_history (buyer_id, subject_id, season, kind, ref_id, title, spent_cents, created_at)
       SELECT buyer_id, member_id, season, 'card', brand, brand, COALESCE(amount_cents, 0), ? FROM gift_card_gifts WHERE season < ?`,
    ).bind(at, t),
  ]);
}

// ---------- share links ----------
// A read-only page of someone's list for people outside their circles: /s/TOKEN (members.share_token,
// migration 0036). It shows published wishes not hidden from any circle, gift cards, sizes and loves, and
// never anything about purchases, so it's safe if the owner opens it too.
const SHARE_RE = /^[A-Za-z0-9_-]{22,40}$/;
const shareToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const escHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SHARE_SIZES = [["shirt", "Shirt / top"], ["pants", "Pants"], ["shoe", "Shoe"], ["ring", "Ring"]];
export async function sharePage(env, token, url) {
  const html = (status, body, title = "Hints") => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow">
<title>${escHtml(title)}</title><link rel="icon" href="/icons/icon-192.png"><link rel="stylesheet" href="/fonts/fonts.css">
<style>
:root{--brand:#7A1E3A;--ink:#2A1A1F;--muted:#7C6A70;--bg:#FBF7F2;--card:#fff;--line:#EFE6E1;--gold:#D9A94A;--gold-soft:#FBF1DC}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 Figtree,system-ui,sans-serif}
h1,h2{font-family:"Bricolage Grotesque",Figtree,sans-serif;margin:0}
header{background:var(--brand);color:#fff;padding:28px 20px 26px}header .in{max-width:860px;margin:0 auto;display:flex;align-items:center;gap:14px}
.av{width:58px;height:58px;border-radius:50%;background:#ffffff26;display:grid;place-items:center;font-weight:800;font-size:24px;overflow:hidden;flex:none}.av img{width:100%;height:100%;object-fit:cover}
header h1{font-size:30px;line-height:1.1}header p{margin:4px 0 0;opacity:.85}
main{max-width:860px;margin:0 auto;padding:18px 16px 40px}
.label{font-weight:800;margin:24px 0 10px;padding-left:10px;border-left:4px solid var(--gold)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.w{background:var(--card);border-radius:16px;padding:12px;display:flex;gap:12px;box-shadow:0 1px 3px #2a1a1f14;text-decoration:none;color:inherit}
.w .im{width:72px;height:72px;border-radius:12px;background:var(--gold-soft);flex:none;overflow:hidden;display:grid;place-items:center;font-size:26px}.w .im img{width:100%;height:100%;object-fit:contain;background:#fff}
.w b{display:block}.w .lk{display:block;margin-top:2px}.w small{color:var(--muted);font-weight:600}.w .top{color:var(--gold);font-weight:800;font-size:13px}.w .pr{font-weight:800;color:var(--brand)}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-weight:600}
.sizes{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}.sizes div{background:var(--card);border-radius:12px;padding:10px 12px}.sizes small{display:block;color:var(--muted);font-weight:700;font-size:12px}
.note{background:var(--gold-soft);border-radius:14px;padding:12px 14px;margin-top:16px;font-size:15px}
footer{text-align:center;color:var(--muted);padding:10px 16px 40px;font-size:14px}footer a{color:var(--brand);font-weight:700}
.empty{text-align:center;padding:60px 20px}
</style></head><body>${body}</body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  const gone = () => html(404, `<main class="empty"><h1>This link isn't active</h1><p>Ask whoever sent it for a new one.</p><p><a href="/">Hints</a></p></main>`);
  if (!SHARE_RE.test(token || "") || !env.DB) return gone();
  const m = await env.DB.prepare("SELECT * FROM members WHERE share_token = ?").bind(token).first();
  if (!m) return gone();
  const p = profileOut(m);
  const { results: all } = await env.DB.prepare(
    `SELECT * FROM items i WHERE i.owner_id = ? AND i.draft = 0 AND i.removed_at IS NULL AND i.held_season IS NULL AND i.received_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM item_hidden h WHERE h.item_id = i.id)
      ORDER BY (i.priority = 'must') DESC, i.created_at`,
  ).bind(m.id).all();
  // Linked wishes: same rule as the app, with what this page shows as what the viewer can see.
  const { results: linkRows } = await env.DB.prepare(`SELECT ${LINK_COLS} FROM items WHERE owner_id = ?`).bind(m.id).all();
  const link = linkInfo(linkRows, new Set(all.map((i) => i.id)));
  const items = all.filter((i) => !link.blocked.has(i.id));
  const linkLine = (i) => {
    const l = link.links.get(i.id) || [];
    const names = (k) => l.filter((x) => x.kind === k).map((x) => escHtml(x.title)).join(", ");
    return [names("together") && `together with ${names("together")}`, names("needs") && `only with ${names("needs")}`, names("pairs") && `goes with ${names("pairs")}`].filter(Boolean).map((t) => `<small class="lk">🔗 ${t}</small>`).join("");
  };
  const { results: cards } = await env.DB.prepare("SELECT brand FROM gift_cards WHERE member_id = ? ORDER BY created_at, brand").bind(m.id).all();
  const name = m.name;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const wish = (i) => {
    const inner = `<span class="im">${i.image_url ? `<img src="${escHtml(i.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "🎁"}</span>
      <span>${i.priority === "must" ? `<span class="top">★ Top pick</span>` : ""}<b>${escHtml(i.title)}</b>
      ${i.price_cents ? `<span class="pr">$${(i.price_cents / 100).toFixed(i.price_cents % 100 ? 2 : 0)}</span> ` : ""}${i.url ? `<small>${escHtml(host(i.url))}</small>` : ""}
      ${(i.quantity ?? 1) !== 1 ? `<small> · ${i.quantity ? `wants ${i.quantity}` : "as many as you like"}</small>` : ""}${linkLine(i)}</span>`;
    return /^https?:\/\//.test(i.url || "") ? `<a class="w" href="${escHtml(i.url)}" target="_blank" rel="noopener nofollow">${inner}</a>` : `<div class="w">${inner}</div>`;
  };
  const sizes = SHARE_SIZES.filter(([k]) => p.sizes[k]);
  const body = `<header><div class="in"><span class="av">${m.photo_at ? `<img src="/api/photo?m=${escHtml(m.id)}&v=${escHtml(m.photo_at)}" alt="">` : escHtml(name.charAt(0).toUpperCase())}</span>
    <div><h1>${escHtml(name)}'s wish list</h1>${p.bio ? `<p>${escHtml(p.bio)}</p>` : ""}</div></div></header>
  <main>
    ${items.length ? `<div class="label">Wishes</div><div class="grid">${items.map(wish).join("")}</div>` : `<p class="note">${escHtml(name)} hasn't added any wishes yet.</p>`}
    ${cards.length ? `<div class="label">Gift cards ${escHtml(name)} would love</div><div class="chips">${cards.filter((c) => GIFT_CARD_NAMES.has(c.brand)).map((c) => `<span class="chip">${escHtml(GIFT_CARD_NAMES.get(c.brand))}</span>`).join("")}</div>` : ""}
    ${sizes.length ? `<div class="label">Sizes</div><div class="sizes">${sizes.map(([k, l]) => `<div><small>${l}</small>${escHtml(p.sizes[k])}</div>`).join("")}</div>` : ""}
    ${p.likes.length ? `<div class="label">Loves</div><div class="chips">${p.likes.map((t) => `<span class="chip">${escHtml(t)}</span>`).join("")}</div>` : ""}
    ${p.brands.length ? `<div class="label">Favorite brands</div><div class="chips">${p.brands.map((t) => `<span class="chip">${escHtml(t)}</span>`).join("")}</div>` : ""}
    <p class="note">Getting something? Tell whoever shared this link, so nobody doubles up.</p>
  </main>
  <footer>Made with <a href="https://${escHtml(url.host)}/">Hints</a>, wish lists for your people.</footer>`;
  return html(200, body, `${name}'s wish list`);
}

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

// ---------- activity feed (Circles tab) ----------
// docs/plans/activity-feed.md. Cards: 'wishes' (someone added wishes), 'profile' (they updated their profile) and
// 'post' (something someone shared, optionally with another card). Who may see a card, and which of its wishes,
// is decided when the feed is read, so a wish hidden or removed later drops out of old cards too.
// Never anything about claims, purchases, budgets, ideas or the hidden chat.
const FEED_KEEP_DAYS = 180;
const FEED_PAGE = 20;
const FEED_EMOJI = ["❤️", "😂", "😍", "🎁", "🔥"];
const FEED_WISH_JOIN_MS = 2 * 3600_000, FEED_WISH_SPAN_MS = 12 * 3600_000, FEED_PROFILE_JOIN_MS = 6 * 3600_000;
const FEED_WISHES_MAX = 30;
// Profile columns worth a card, and the name the app shows for each.
const FEED_FIELDS = { photo_at: "photo", cover_at: "cover", bio: "bio", likes: "likes", dislikes: "dislikes", sizes: "sizes",
  colors: "colors", brands: "brands", gift_style: "giftStyle", owns: "owns" };
const feedCutoff = () => new Date(Date.now() - FEED_KEEP_DAYS * 86_400_000).toISOString();
const feedMeta = (r) => { try { return JSON.parse(r.meta || "{}") || {}; } catch { return {}; } };

// Adds to the actor's latest card of this kind when it's recent enough, otherwise starts a new one.
async function feedJoin(env, actorId, kind, joinMs, add) {
  const t = now();
  const last = await env.DB.prepare(
    "SELECT id, meta, created_at FROM feed WHERE actor_id = ? AND kind = ? AND deleted_at IS NULL AND updated_at > ? ORDER BY updated_at DESC LIMIT 1",
  ).bind(actorId, kind, new Date(Date.now() - joinMs).toISOString()).first();
  if (last && (kind !== "wishes" || Date.now() - Date.parse(last.created_at) < FEED_WISH_SPAN_MS)) {
    await env.DB.prepare("UPDATE feed SET meta = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(add(feedMeta(last))), t, last.id).run();
    return last.id;
  }
  const id = newId();
  await env.DB.prepare("INSERT INTO feed (id, actor_id, kind, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, actorId, kind, JSON.stringify(add({})), t, t).run();
  return id;
}
// A wish just went on someone's list (published, or saved straight to it for someone you look after).
async function feedWish(env, ownerId, itemId) {
  await feedJoin(env, ownerId, "wishes", FEED_WISH_JOIN_MS, (m) => {
    const items = (m.items || []).filter((x) => x !== itemId);
    items.unshift(itemId);
    return { items: items.slice(0, FEED_WISHES_MAX) };
  }).catch((err) => console.error("feed wish", err));
}
const feedProfileCols = Object.keys(FEED_FIELDS).join(", ");
const feedProfileSnap = (env, id) => env.DB.prepare(`SELECT ${feedProfileCols} FROM members WHERE id = ?`).bind(id).first();
// What changed between two snapshots. Only something new counts: clearing a field (or removing a photo) doesn't.
const feedBlank = (v) => v == null || v === "" || v === "[]" || v === "{}";
async function feedProfile(env, who, before, after) {
  if (!before || !after) return;
  const fields = Object.entries(FEED_FIELDS).filter(([col]) => !feedBlank(after[col]) && after[col] !== before[col]).map(([, k]) => k);
  if (!fields.length) return;
  await feedJoin(env, who, "profile", FEED_PROFILE_JOIN_MS, (m) => ({ fields: [...new Set([...fields, ...(m.fields || [])])] }))
    .catch((err) => console.error("feed profile", err));
}

// SQL: feed row f is for the viewer (?1): the actor shares a circle with them (the post's circle, if it has one).
const FEED_SEES = `f.deleted_at IS NULL AND EXISTS (SELECT 1 FROM group_members x JOIN group_members y ON y.group_id = x.group_id
   WHERE x.member_id = ?1 AND y.member_id = f.actor_id AND (f.group_id IS NULL OR x.group_id = f.group_id))`;
// SQL: member column `col` is the viewer (?1) or shares a circle with them.
const FEED_KNOWS = (col) => `(${col} = ?1 OR EXISTS (SELECT 1 FROM group_members x JOIN group_members y ON y.group_id = x.group_id WHERE x.member_id = ?1 AND y.member_id = ${col}))`;

async function feedRowFor(env, meId, id) {
  const r = await env.DB.prepare(`SELECT f.* FROM feed f WHERE f.id = ?2 AND ${FEED_SEES}`).bind(meId, String(id || "")).first();
  if (!r) fail(404, "That post isn't there anymore.");
  return r;
}

// Turns feed rows into cards for one viewer. Wishes go through ITEM_VISIBLE (yours: just published and not removed).
// A wishes card with nothing left is dropped, and so is a shared card the viewer can no longer see (it shows as gone).
async function feedCards(env, meId, rows) {
  if (!rows.length) return [];
  const shareIds = [...new Set(rows.filter((r) => r.share_id).map((r) => r.share_id))];
  const shared = new Map();
  for (let i = 0; i < shareIds.length; i += 50) {
    const ids = shareIds.slice(i, i + 50);
    const { results } = await env.DB.prepare(`SELECT f.* FROM feed f WHERE f.id IN (${ids.map(() => "?").join(",")}) AND ${FEED_SEES.replace(/\?1/g, "?" + (ids.length + 1))}`)
      .bind(...ids, meId).all();
    for (const r of results) shared.set(r.id, r);
  }
  const all = [...rows, ...shared.values()];
  const itemIds = [...new Set(all.filter((r) => r.kind === "wishes").flatMap((r) => feedMeta(r).items || []))];
  const items = new Map();
  for (let i = 0; i < itemIds.length; i += 80) {
    const ids = itemIds.slice(i, i + 80);
    const { results } = await env.DB.prepare(
      `SELECT i.id, i.owner_id, i.title, i.image_url, i.price_cents FROM items i WHERE i.id IN (${ids.map(() => "?").join(",")}) AND i.removed_at IS NULL
         AND (i.owner_id = ?${ids.length + 1} AND i.draft = 0 OR ${ITEM_VISIBLE.replace("?", "?" + (ids.length + 1))})`,
    ).bind(...ids, meId).all();
    for (const r of results) items.set(r.id, r);
  }
  const ids = [...new Set(all.map((r) => r.id))];
  const reacts = new Map(), comments = new Map();
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80), q = part.map(() => "?").join(","), me = `?${part.length + 1}`;
    const { results: rr } = await env.DB.prepare(
      `SELECT r.feed_id, r.member_id, r.emoji FROM feed_reactions r WHERE r.feed_id IN (${q}) AND ${FEED_KNOWS("r.member_id").replace(/\?1/g, me)}`,
    ).bind(...part, meId).all();
    for (const r of rr) (reacts.get(r.feed_id) || reacts.set(r.feed_id, []).get(r.feed_id)).push(r);
    const { results: cr } = await env.DB.prepare(
      `SELECT c.id, c.feed_id, c.author_id, c.body, c.created_at, m.name AS author_name FROM feed_comments c JOIN members m ON m.id = c.author_id
        WHERE c.feed_id IN (${q}) AND c.deleted_at IS NULL AND ${FEED_KNOWS("c.author_id").replace(/\?1/g, me)} ORDER BY c.created_at`,
    ).bind(...part, meId).all();
    for (const c of cr) (comments.get(c.feed_id) || comments.set(c.feed_id, []).get(c.feed_id)).push(c);
  }
  const names = new Map();
  const actorIds = [...new Set(all.map((r) => r.actor_id))];
  if (actorIds.length) {
    const { results } = await env.DB.prepare(`SELECT id, name FROM members WHERE id IN (${actorIds.map(() => "?").join(",")})`).bind(...actorIds).all();
    for (const r of results) names.set(r.id, r.name);
  }
  const groupIds = [...new Set(all.map((r) => r.group_id).filter(Boolean))];
  const groups = new Map();
  if (groupIds.length) {
    const { results } = await env.DB.prepare(`SELECT id, name FROM groups WHERE id IN (${groupIds.map(() => "?").join(",")})`).bind(...groupIds).all();
    for (const r of results) groups.set(r.id, r.name);
  }
  const nicks = await nicknamesFor(env, meId);
  const who = (id, name) => ({ id, name: id === meId ? "You" : nicks.get(id) || name || "Someone" });
  const commentOut = (c, owner) => ({ id: c.id, author: who(c.author_id, c.author_name), body: c.body, at: c.created_at,
    mine: c.author_id === meId, canDelete: c.author_id === meId || owner === meId });
  const card = (r, inner) => {
    const base = { id: r.id, kind: r.kind, actor: who(r.actor_id, names.get(r.actor_id)), at: r.updated_at, created: r.created_at, mine: r.actor_id === meId,
      circle: r.group_id ? { id: r.group_id, name: groups.get(r.group_id) || "" } : null };
    if (r.kind === "wishes") {
      const shown = (feedMeta(r).items || []).map((id) => items.get(id)).filter(Boolean);
      if (!shown.length) return null;
      Object.assign(base, { items: shown.slice(0, 4).map((i) => ({ id: i.id, title: i.title, image_url: i.image_url || null, price_cents: i.price_cents })), count: shown.length, more: Math.max(0, shown.length - 4) });
    } else if (r.kind === "profile") {
      base.fields = feedMeta(r).fields || [];
    } else {
      base.body = r.body || "";
      base.edited = !!r.edited_at;
      if (r.share_id && !inner) base.shared = (shared.has(r.share_id) && card(shared.get(r.share_id), true)) || { gone: true };
    }
    if (inner) return base;
    const rx = reacts.get(r.id) || [];
    const counts = {};
    for (const x of rx) counts[x.emoji] = (counts[x.emoji] || 0) + 1;
    base.reactions = { counts, total: rx.length, mine: rx.find((x) => x.member_id === meId)?.emoji || null };
    const cs = comments.get(r.id) || [];
    base.comments = { count: cs.length, latest: cs.slice(-2).map((c) => commentOut(c, r.actor_id)) };
    return base;
  };
  return rows.map((r) => card(r, false)).filter(Boolean);
}
async function feedCommentsFor(env, meId, row) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.author_id, c.body, c.created_at, m.name AS author_name FROM feed_comments c JOIN members m ON m.id = c.author_id
      WHERE c.feed_id = ?2 AND c.deleted_at IS NULL AND ${FEED_KNOWS("c.author_id")} ORDER BY c.created_at LIMIT 500`,
  ).bind(meId, row.id).all();
  const nicks = await nicknamesFor(env, meId);
  return results.map((c) => ({ id: c.id, author: { id: c.author_id, name: c.author_id === meId ? "You" : nicks.get(c.author_id) || c.author_name },
    body: c.body, at: c.created_at, mine: c.author_id === meId, canDelete: c.author_id === meId || row.actor_id === meId }));
}
// Someone commented on your card: one notification, replaced by the next (same tag). Never for your own comment.
async function feedCommented(env, author, row, textBody) {
  if (row.actor_id === author.id) return;
  const r = await env.DB.prepare(`SELECT m.notify FROM members m WHERE m.id = ? AND m.managed_by IS NULL
      AND EXISTS (SELECT 1 FROM push_subs s WHERE s.member_id = m.id AND ${LIVE_SUB})`).bind(row.actor_id).first();
  if (!r || !notifyPrefs(r.notify).feed) return;
  const nicks = await nicknamesFor(env, row.actor_id);
  const what = row.kind === "post" ? "your post" : row.kind === "wishes" ? "your new wishes" : "your profile update";
  await pushTo(env, row.actor_id, {
    title: `${nicks.get(author.id) || author.name} commented on ${what}`,
    body: textBody.length > 140 ? `${textBody.slice(0, 137)}...` : textBody,
    url: "/#family", tag: `feed:${row.id}`,
  });
}
// Everything feed that belongs to a person (account deleted).
const feedForget = (env, id) => [
  env.DB.prepare("DELETE FROM feed_reactions WHERE member_id = ?1 OR feed_id IN (SELECT id FROM feed WHERE actor_id = ?1)").bind(id),
  env.DB.prepare("DELETE FROM feed_comments WHERE author_id = ?1 OR feed_id IN (SELECT id FROM feed WHERE actor_id = ?1)").bind(id),
  env.DB.prepare("DELETE FROM feed WHERE actor_id = ?1").bind(id),
];
async function feedSweep(env) {
  const cut = feedCutoff();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM feed_reactions WHERE feed_id IN (SELECT id FROM feed WHERE updated_at < ?1 OR deleted_at IS NOT NULL)").bind(cut),
    env.DB.prepare("DELETE FROM feed_comments WHERE created_at < ?1 OR feed_id IN (SELECT id FROM feed WHERE updated_at < ?1 OR deleted_at IS NOT NULL)").bind(cut),
    env.DB.prepare("DELETE FROM feed WHERE updated_at < ?1 OR deleted_at < ?1").bind(cut),
  ]);
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
  // Requests they sent for this household go with them.
  rows.push(env.DB.prepare("DELETE FROM household_requests WHERE household_id = ? AND invited_by = ?").bind(hh, memberId));
  // Anyone not doing gifts with this household still isn't doing gifts with them.
  rows.push(env.DB.prepare(
    "INSERT INTO budget_skips (author_id, target, created_at) SELECT author_id, 'm:' || ?, ? FROM budget_skips WHERE target = 'h:' || ? AND author_id != ? ON CONFLICT DO NOTHING",
  ).bind(memberId, now(), hh, memberId));
  await env.DB.batch(rows);
  const still = await env.DB.prepare("SELECT 1 FROM members WHERE household_id = ? LIMIT 1").bind(hh).first();
  if (!still) {
    await env.DB.batch([
      // The last one out takes the pets.
      env.DB.prepare("UPDATE pets SET member_id = ?, household_id = NULL WHERE household_id = ?").bind(memberId, hh),
      // Budgets other households set for this household's Christmas now belong to the last one out.
      env.DB.prepare(
        `INSERT INTO household_budgets (household_id, target, season, amount_cents, updated_by, updated_at)
         SELECT household_id, 'm:' || ?, season, amount_cents, updated_by, updated_at FROM household_budgets WHERE target = 'h:' || ?
         ON CONFLICT (household_id, target, season) DO UPDATE SET amount_cents = amount_cents + excluded.amount_cents`,
      ).bind(memberId, hh),
      env.DB.prepare("DELETE FROM household_budgets WHERE target = 'h:' || ?").bind(hh),
      ...dropHousehold(env, hh),
    ]);
  }
}

// Statements that delete a household nobody is in, with everything that points at it (foreign keys).
function dropHousehold(env, hh) {
  return [
    env.DB.prepare("DELETE FROM household_requests WHERE household_id = ?").bind(hh),
    // Nobody's left to share these. (Leaving starts you fresh, so nothing is copied out.)
    env.DB.prepare("DELETE FROM household_budgets WHERE household_id = ?").bind(hh),
    env.DB.prepare("DELETE FROM budget_skips WHERE target = 'h:' || ?").bind(hh),
    env.DB.prepare("DELETE FROM group_households WHERE household_id = ?").bind(hh),
    env.DB.prepare("DELETE FROM households WHERE id = ?").bind(hh),
  ];
}

// Puts someone with no household into household `hh`: their pets come along and they join every circle the
// household is in. Throws on a same-name clash or a full circle. Callers check who may do this.
async function joinHousehold(env, memberId, hh) {
  const them = await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(memberId).first();
  const { results } = await env.DB.prepare("SELECT group_id FROM group_households WHERE household_id = ?").bind(hh).all();
  const clash = await nameClash(env, results.map((r) => r.group_id), [memberId], hh);
  if (clash) fail(409, `Someone named ${them?.name} with the same last name is already in ${clash}, which this household is in.`);
  for (const r of results) {
    const inIt = await env.DB.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND member_id = ?").bind(r.group_id, memberId).first();
    if (!inIt) await circleRoom(env, r.group_id);
  }
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE members SET household_id = ? WHERE id = ?").bind(hh, memberId),
    petsInto(env, memberId, hh),
    env.DB.prepare(
      "INSERT INTO group_members (group_id, member_id, joined_at, direct) SELECT group_id, ?, ?, 0 FROM group_households WHERE household_id = ? ON CONFLICT DO NOTHING",
    ).bind(memberId, t, hh),
    // Joined: any other household they were asked to join is moot.
    env.DB.prepare("DELETE FROM household_requests WHERE member_id = ?").bind(memberId),
  ]);
  return budgetsOnJoin(env, memberId, hh);
}

// Budgets follow people (household budgets plan, rule 4). `memberId` just joined household `hh` (from none):
//   - Their personal budgets for people outside it move into the household's shared ones. Where the household
//     already has one for that person and occasion, the household's stays. Returns those: [{ target, season }].
//   - Budgets the household had for them as an outsider become the personal budget of whoever set them.
//   - Other households' Christmas budgets for them add into the one for their new household.
async function budgetsOnJoin(env, memberId, hh) {
  const t = today();
  const stamp = now();
  const { results: mine } = await env.DB.prepare(
    `SELECT b.subject_id, b.season, b.amount_cents, s.household_id FROM budgets b JOIN members s ON s.id = b.subject_id
      WHERE b.author_id = ? AND b.season >= ? AND (s.household_id IS NULL OR s.household_id != ?)`,
  ).bind(memberId, t, hh).all();
  const moved = new Map();
  for (const r of mine) {
    const key = `${budgetTarget({ id: r.subject_id, household_id: r.household_id }, r.season)}|${r.season}`;
    moved.set(key, (moved.get(key) || 0) + r.amount_cents);
  }
  const kept = [];
  for (const [key, amount] of moved) {
    const [target, season] = key.split("|");
    const res = await env.DB.prepare(
      "INSERT INTO household_budgets (household_id, target, season, amount_cents, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ).bind(hh, target, Number(season), amount, memberId, stamp).run();
    if (!res.meta?.changes) kept.push({ target, season: Number(season) });
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM budgets WHERE author_id = ? AND season >= ? AND subject_id IN (SELECT id FROM members WHERE household_id IS NULL OR household_id != ?)",
    ).bind(memberId, t, hh),
    // They're family now: what the household had set for them becomes the setter's own budget.
    env.DB.prepare(
      `INSERT INTO budgets (author_id, subject_id, season, amount_cents)
       SELECT hb.updated_by, ?, hb.season, hb.amount_cents FROM household_budgets hb JOIN members u ON u.id = hb.updated_by AND u.household_id = ?
        WHERE hb.household_id = ? AND hb.target = 'm:' || ? AND hb.updated_by != ? ON CONFLICT DO NOTHING`,
    ).bind(memberId, hh, hh, memberId, memberId),
    env.DB.prepare("DELETE FROM household_budgets WHERE household_id = ? AND target = 'm:' || ?").bind(hh, memberId),
    // Other households planned their Christmas as one person; now it's their household's.
    env.DB.prepare(
      `INSERT INTO household_budgets (household_id, target, season, amount_cents, updated_by, updated_at)
       SELECT household_id, 'h:' || ?, season, amount_cents, updated_by, updated_at FROM household_budgets
        WHERE target = 'm:' || ? AND season % 10000 = 1225
       ON CONFLICT (household_id, target, season) DO UPDATE SET amount_cents = amount_cents + excluded.amount_cents`,
    ).bind(hh, memberId),
    env.DB.prepare("DELETE FROM household_budgets WHERE target = 'm:' || ? AND season % 10000 = 1225").bind(memberId),
  ]);
  return kept;
}

// ---------- household requests (migration 0044) ----------
// Joining a household shares its budgets and purchases both ways, so someone who uses Hints is asked first.
// People who don't use the app (managed) are added directly.
const usesApp = async (env, memberId) => !!(await env.DB.prepare("SELECT 1 FROM members WHERE id = ? AND managed_by IS NULL").bind(memberId).first());

// Asks `memberId` to join household `hh` (null: start one with `meId`). Returns false if they were already asked.
async function askToJoinHousehold(env, me, memberId, hh) {
  const res = await env.DB.prepare(
    "INSERT INTO household_requests (id, member_id, household_id, invited_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  ).bind(newId(), memberId, hh, me.id, now()).run();
  if (!res.meta?.changes) return false;
  const nick = (await env.DB.prepare("SELECT nickname FROM nicknames WHERE author_id = ? AND subject_id = ?").bind(memberId, me.id).first())?.nickname;
  await pushTo(env, memberId, {
    title: `${nick || me.name} wants to add you to a household`,
    body: "You'd plan gifts together for everyone outside it. Tap to answer.",
    url: "/", tag: `hhreq:${me.id}`,
  }).catch((err) => console.error("household request push", err));
  return true;
}

// A household nobody is in and nobody is still being asked to join (made by household/create) goes away.
async function dropIfEmpty(env, hh) {
  if (!hh) return;
  const used = await env.DB.prepare(
    "SELECT 1 FROM members WHERE household_id = ?1 UNION ALL SELECT 1 FROM household_requests WHERE household_id = ?1 LIMIT 1",
  ).bind(hh).first();
  if (!used) await env.DB.batch(dropHousehold(env, hh));
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

// ---------- pets ----------
// Not people: no list, login or birthday, just info for gift-givers (migration 0037). A pet belongs to a household,
// or to someone who isn't in one. Same visibility as the household or person; edited by the household (or the
// circle's admin, like the rest of the household), or by the person and whoever looks after them.
const PET_KINDS = new Set(["dog", "cat", "bird", "fish", "bunny", "reptile", "horse", "other"]);
const PETS_MAX = 12;
const petOut = (r) => ({ id: r.id, name: r.name, kind: r.kind, notes: r.notes || null, photo: r.photo_at || null });
// Someone joins household `hh`: their own pets come with them.
const petsInto = (env, memberId, hh) => env.DB.prepare("UPDATE pets SET household_id = ?, member_id = NULL WHERE member_id = ?").bind(hh, memberId);
// Pets of these households and people: { "h:<id>": [...], "m:<id>": [...] }, oldest first.
async function petsFor(env, householdIds, memberIds) {
  const out = {};
  const run = async (col, prefix, ids) => {
    if (!ids.length) return;
    const { results } = await env.DB.prepare(
      `SELECT id, household_id, member_id, name, kind, notes, photo_at FROM pets WHERE ${col} IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`,
    ).bind(...ids).all();
    for (const r of results) (out[`${prefix}:${r[col]}`] ||= []).push(petOut(r));
  };
  await Promise.all([run("household_id", "h", householdIds), run("member_id", "m", memberIds)]);
  return out;
}
// Whose pets a write is for: { household } or { member }. Throws when it isn't yours to change.
async function petOwner(env, me, { householdId, as }) {
  if (householdId) return { household: await manageableHousehold(env, me.id, householdId) };
  const who = await ownerFor(env, me, as);
  // In a household: pets live there, not on the person.
  const hh = await householdOf(env, who);
  return hh ? { household: hh } : { member: who };
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
async function sha256(textValue) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(textValue)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
// The person a personal link is for, or 404. A personal link is reusable: the first time it hands a list someone
// set up over to them, and after that it signs them in again on a new phone (asking for their PIN if they set
// one). It works until a new link replaces it or it's turned off. claim_expires is only set on links made before
// links became reusable (they still expire).
async function claimFor(env, token) {
  const tk = String(token || "");
  if (!/^[A-Za-z0-9]{20,64}$/.test(tk)) fail(404, "That link didn't work.");
  const row = await env.DB.prepare(
    "SELECT id, name, managed_by, claim_expires, pin_hash, pin_cleared_at FROM members WHERE claim_hash = ?",
  ).bind(await sha256(tk)).first();
  if (!row || (row.claim_expires && row.claim_expires < now())) fail(404, "That link isn't active anymore. Ask for a new one.");
  return row;
}
const newLinkToken = () => randomString(24, "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789");
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

// Signs out (on every device) someone who's in no circle and waiting on no request: there's nothing to show them.
// Just you, no circle (POST start without a circle name). Your personal sign-in link is made right away (link
// + PIN is how you get back in on a new phone until you're in a circle).
async function startSolo(req, env, b) {
  const name = text(b.name, LIMITS.name, "Your first name", true);
  const lastName = lastNameOf(b.lastName);
  const pin = pinValue(b.pin);
  if (!pin) fail(428, "Pick a 4-digit PIN. You'll use it to sign in on a new phone.");
  await rateLimit(env, `start:ip:${ipOf(req)}`, ABUSE.startPerIp, "Too many new lists from here today. Try again tomorrow.");
  await newMemberAllowed(env, req);
  const id = newId();
  const link = newLinkToken();
  await env.DB.prepare("INSERT INTO members (id, name, last_name, pin_hash, claim_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, name, lastName, await hashPin(env, id, pin), await sha256(link), now()).run();
  return { token: await signIn(env, id), link };
}

// Removes a person and everything that is theirs or about them (account/delete).
async function deleteMember(env, id) {
  // People they look after go to someone else who can manage them: a household mate, else a circle's admin.
  const { results: kids } = await env.DB.prepare("SELECT id, name FROM members WHERE managed_by = ?").bind(id).all();
  const stuck = [];
  for (const k of kids) {
    const myHh = await householdOf(env, id);
    let next = myHh && (await env.DB.prepare("SELECT id FROM members WHERE household_id = ? AND id != ? AND managed_by IS NULL ORDER BY created_at LIMIT 1").bind(myHh, id).first())?.id;
    if (!next) {
      const { results } = await env.DB.prepare("SELECT group_id FROM group_members WHERE member_id = ?").bind(k.id).all();
      for (const r of results) {
        const a = await adminOf(env, r.group_id);
        if (a && a !== id) { next = a; break; }
      }
    }
    if (next) await env.DB.prepare("UPDATE members SET managed_by = ? WHERE id = ?").bind(next, k.id).run();
    else stuck.push(k.name);
  }
  if (stuck.length) fail(409, `Nobody else can look after ${stuck.join(" and ")}. Tap Let them sign in or Remove on their page first.`);
  await leaveHousehold(env, id);
  const { results: circles } = await env.DB.prepare(
    "SELECT gm.group_id, (SELECT COUNT(*) FROM group_members x JOIN members m ON m.id = x.member_id WHERE x.group_id = gm.group_id AND x.member_id != ?1 AND m.managed_by IS NULL) AS others FROM group_members gm WHERE gm.member_id = ?1",
  ).bind(id).all();
  const rows = [];
  // A circle nobody else uses goes too (with anyone in it who was only ever set up, never signed in, left as is).
  for (const c of circles.filter((c) => !c.others)) {
    rows.push(
      env.DB.prepare("DELETE FROM item_hidden WHERE group_id = ?").bind(c.group_id),
      env.DB.prepare("DELETE FROM chat_reads WHERE group_id = ?").bind(c.group_id),
      env.DB.prepare("DELETE FROM chat_messages WHERE group_id = ?").bind(c.group_id),
      env.DB.prepare("UPDATE feed SET deleted_at = ? WHERE group_id = ?").bind(now(), c.group_id),
      env.DB.prepare("DELETE FROM group_households WHERE group_id = ?").bind(c.group_id),
      env.DB.prepare("DELETE FROM join_requests WHERE group_id = ?").bind(c.group_id),
      env.DB.prepare("DELETE FROM group_members WHERE group_id = ?").bind(c.group_id),
      env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(c.group_id),
    );
  }
  const q = (sql) => rows.push(env.DB.prepare(sql).bind(id));
  q("DELETE FROM idea_claims WHERE buyer_id = ?1 OR idea_id IN (SELECT id FROM private_ideas WHERE author_id = ?1 OR subject_id = ?1)");
  q("DELETE FROM private_ideas WHERE author_id = ?1 OR subject_id = ?1");
  q("DELETE FROM claims WHERE buyer_id = ?1 OR item_id IN (SELECT id FROM items WHERE owner_id = ?1)");
  q("DELETE FROM item_hidden WHERE item_id IN (SELECT id FROM items WHERE owner_id = ?1)");
  q("DELETE FROM items WHERE owner_id = ?1");
  q("DELETE FROM budgets WHERE author_id = ?1 OR subject_id = ?1");
  q("DELETE FROM nicknames WHERE author_id = ?1 OR subject_id = ?1");
  q("DELETE FROM gift_card_gifts WHERE member_id = ?1 OR buyer_id = ?1");
  q("DELETE FROM gift_cards WHERE member_id = ?1");
  q("DELETE FROM chat_messages WHERE author_id = ?1 OR subject_id = ?1");
  q("DELETE FROM chat_reads WHERE member_id = ?1 OR subject_id = ?1");
  rows.push(...feedForget(env, id));
  q("DELETE FROM push_subs WHERE member_id = ?1");
  q("DELETE FROM push_later WHERE member_id = ?1");
  q("DELETE FROM list_seen WHERE viewer_id = ?1 OR owner_id = ?1");
  q("DELETE FROM household_budgets WHERE target = 'm:' || ?1");
  q("UPDATE household_budgets SET updated_by = NULL WHERE updated_by = ?1");
  q("DELETE FROM budget_skips WHERE author_id = ?1 OR target = 'm:' || ?1");
  q("DELETE FROM household_requests WHERE member_id = ?1 OR invited_by = ?1");
  q("DELETE FROM gift_history WHERE buyer_id = ?1 OR subject_id = ?1");
  q("DELETE FROM pets WHERE member_id = ?1");
  q("UPDATE reports SET member_id = NULL WHERE member_id = ?1");
  q("UPDATE members SET pin_cleared_by = NULL WHERE pin_cleared_by = ?1");
  q("DELETE FROM join_requests WHERE member_id = ?1");
  q("DELETE FROM group_members WHERE member_id = ?1");
  q("DELETE FROM devices WHERE member_id = ?1");
  q("DELETE FROM passkeys WHERE member_id = ?1");
  q("DELETE FROM passkey_challenges WHERE member_id = ?1");
  await env.DB.batch(rows);
  // Circles they ran get the next admin (adminOf picks whoever has been in longest); then the person goes.
  for (const c of circles.filter((c) => c.others)) await adminOf(env, c.group_id);
  await env.DB.batch([
    env.DB.prepare("UPDATE groups SET created_by = NULL WHERE created_by = ?").bind(id),
    env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id),
  ]);
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
  const group = await env.DB.prepare("SELECT id, name, join_code, ask_to_join, link_claims FROM groups WHERE join_code = ?").bind(c).first();
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

// Received wishes, newest first. Never says who gave them.
const receivedOut = (rows) => rows.filter((r) => r.received_at)
  .sort((a, b) => (b.received_season - a.received_season) || b.received_at.localeCompare(a.received_at))
  .map((r) => ({ id: r.id, title: r.title, url: r.url, image_url: r.image_url, price_cents: r.price_cents, season: r.received_season, thanked: !!r.thanked_at }));

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
  held: r.held_season || null, // waiting on "Did you get this?" for this occasion (owner only sees it)
  draft: !!r.draft,
  created_at: r.created_at,
  updated_at: r.updated_at,
  image_url: r.image_url || null,
  image_checked: !!r.image_checked_at,
  price_checked: !!r.price_checked_at,
  price_auto: !!r.price_auto,
  price_guess: r.price_auto === 2,
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
  price_guess: r.price_auto === 2,
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

// Every JSON object in the page's JSON-LD blocks, breadth first (top-level things before what's nested in them).
// Stores write messy JSON-LD: wrapped in CDATA or HTML comments, raw line breaks inside strings, trailing commas,
// and the product nested under a WebPage's mainEntity. All of those still count.
function parseLd(raw) {
  let t = raw.trim().replace(/^\s*(\/\*\s*)?<!\[CDATA\[(\s*\*\/)?|(\/\*\s*)?\]\]>(\s*\*\/)?\s*$/g, "").replace(/^\s*<!--|-->\s*$/g, "").trim();
  try { return JSON.parse(t); } catch {}
  t = t.replace(/[\u0000-\u001f]+/g, " ").replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(t); } catch { return null; }
}
const LD_NEST = ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item", "about", "subjectOf"];
function* ldNodes(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const queue = [parseLd(m[1])];
    let seen = 0;
    while (queue.length && seen++ < 2000) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) { queue.push(...node); continue; }
      yield node;
      // Only where stores put the page's product, not variants, reviews or "similar products".
      for (const k of LD_NEST) if (node[k] && typeof node[k] === "object") queue.push(node[k]);
    }
  }
}
const ldType = (node) => [].concat(node["@type"] || []).join(" ");

function optionsFromJsonLd(html) {
  const sizes = [], colors = [];
  let size = "", color = "";
  for (const node of ldNodes(html)) {
    const type = ldType(node);
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
    const c = tag?.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const content = c?.[1] ?? c?.[2];
    if (content?.trim()) return decode(content);
  }
  return null;
}

const toPrice = (v) => {
  if (v === null || v === undefined || v === "") return null;
  let n;
  if (typeof v === "number") n = v;
  else {
    const m = String(v).match(/\d[\d.,]*/);
    if (!m) return null;
    let t = m[0].replace(/[.,]$/, "");
    // 1.299,00 or 12,50: a comma before the last two digits is the decimal point.
    if (/,\d{2}$/.test(t) && !/\.\d{2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
    n = parseFloat(t);
  }
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null;
};

// ---------- currency: everything is shown in US dollars ----------
// A store's own currency comes from JSON-LD (priceCurrency), price meta tags, or Shopify's page setup. Other
// currencies are converted with the day's ECB rate (Frankfurter, free, no key, cached a day) and marked as a
// guess, since rates move and stores price each country differently.
const CUR_SIGNS = { "$": "USD", "US$": "USD", "£": "GBP", "€": "EUR", "C$": "CAD", "CA$": "CAD", "A$": "AUD", "AU$": "AUD", "¥": "JPY" };
function currencyCode(v) {
  const t = String(v || "").trim();
  if (!t) return null;
  if (CUR_SIGNS[t]) return CUR_SIGNS[t];
  return /^[A-Za-z]{3}$/.test(t) ? t.toUpperCase() : null;
}
function pageCurrency(html, ld) {
  if (!html) return null;
  return currencyCode(ld?.currency)
    || currencyCode(meta(html, "product:price:currency", "og:price:currency", "priceCurrency"))
    || currencyCode(html.match(/Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Za-z]{3})"/)?.[1]);
}
// Shopify's product .js prices are in the currency the store shows us; /cart.js says which one.
async function shopifyCurrency(url, html) {
  const fromPage = pageCurrency(html, null);
  if (fromPage) return fromPage;
  try {
    const res = await safeFetch(`${url.origin}/cart.js`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
    if (!res?.ok) { res?.body?.cancel().catch(() => {}); return null; }
    return currencyCode(JSON.parse(await readCapped(res, 100_000))?.currency);
  } catch { return null; }
}
const FX_TTL = 24 * 3600;
async function usdRate(cur) {
  const key = new Request(`https://fx.wishlist.invalid/${cur}`);
  try { const hit = await caches.default.match(key); if (hit) return Number(await hit.text()) || null; } catch {}
  let rate = null;
  for (const u of [`https://api.frankfurter.dev/v1/latest?base=${cur}&symbols=USD`, `https://api.frankfurter.app/latest?from=${cur}&to=USD`]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(3000) });
      if (r.ok) rate = Number((await r.json())?.rates?.USD) || null;
    } catch {}
    if (rate) break;
  }
  if (rate) { try { await caches.default.put(key, new Response(String(rate), { headers: { "cache-control": `max-age=${FX_TTL}` } })); } catch {} }
  else console.log(`fx ${cur} unavailable`);
  return rate;
}
// A store price in US dollars. No currency means dollars. A currency we can't convert gives no price.
async function inUsd(price, currency) {
  const cur = currencyCode(currency);
  if (price == null || !cur || cur === "USD") return { price, guess: false };
  const rate = await usdRate(cur);
  return rate ? { price: Math.round(price * rate * 100) / 100, guess: true, from: cur } : { price: null, guess: false };
}

// Finds a schema.org Product in JSON-LD blocks (most stores include one). The first one with a name wins.
// Price: the first offer (or variant offer) with a real price, including prices tucked in priceSpecification.
const offerPrice = (o) => o && typeof o === "object"
  ? toPrice(o.price) ?? toPrice(o.lowPrice) ?? [].concat(o.priceSpecification || []).map((p) => toPrice(p?.price)).find((p) => p != null) ?? null
  : null;
function jsonLdProduct(html) {
  let unnamed = null;
  for (const node of ldNodes(html)) {
    if (!/Product/i.test(ldType(node))) continue;
    const offers = [].concat(node.offers || [], ...[].concat(node.hasVariant || []).map((v) => [].concat(v?.offers || [])));
    const flat = offers.flatMap((o) => [o, ...[].concat(o?.offers || [])]);
    const priced = flat.find((o) => offerPrice(o) != null);
    const price = priced ? offerPrice(priced) : null;
    const spec = priced && [].concat(priced.priceSpecification || []).find((x) => x?.priceCurrency);
    const currency = priced ? String(priced.priceCurrency || spec?.priceCurrency || "").trim() || null : null;
    const img = [].concat(node.image || [])[0];
    const image = typeof img === "string" ? img : img?.url || img?.contentUrl || null;
    const avail = String(flat.map((o) => o?.availability).find(Boolean) || "");
    const inStock = /InStock|LimitedAvailability|OnlineOnly|PreOrder|InStoreOnly/i.test(avail) ? true : /OutOfStock|SoldOut|Discontinued/i.test(avail) ? false : null;
    const b = [].concat(node.brand || node.manufacturer || [])[0];
    const brand = typeof b === "string" ? decode(b) : b?.name ? decode(b.name) : null;
    const name = typeof node.name === "string" ? decode(node.name) : null;
    const out = { title: name || null, price, currency, image, inStock, brand };
    if (name) return unnamed && out.price == null ? { ...out, price: unnamed.price, currency: unnamed.currency, image: out.image || unnamed.image }
      : unnamed ? { ...out, image: out.image || unnamed.image } : out;
    unnamed ||= out;
  }
  return unnamed || {};
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
- price: what the store charges for it right now as a number, in the store's own currency (the sale price if it's
  on sale, never a "was", "comparable value" or list price), or null if you can't tell
- currency: the 3-letter code of that price's currency (USD, GBP, EUR...), or "" if unsure
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
    currency: { type: "string" },
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
// True when Gemini's url_context tool really loaded this link (same host), not just a Google search about it.
function openedPage(meta, url) {
  const list = [].concat(meta?.urlMetadata || meta?.url_metadata || []);
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return false; }
  return list.some((m) => {
    const status = String(m?.urlRetrievalStatus || m?.url_retrieval_status || "");
    let h = "";
    try { h = new URL(m?.retrievedUrl || m?.retrieved_url || "").hostname.replace(/^www\./, ""); } catch {}
    return /SUCCESS/i.test(status) && (h === host || h.endsWith("." + host) || host.endsWith("." + h));
  });
}

// Shopify stores answer /products/<handle>.js with exact prices (in cents) and stock per variant.
// Much more reliable than the page, and works on stores whose pages we can't read.
async function shopifyProduct(url) {
  const m = url.pathname.match(/^(.*\/products\/[^/.]+)\/?$/);
  if (!m) return null;
  try {
    const res = await safeFetch(new URL(`${m[1]}.js`, url.origin), {
      signal: AbortSignal.timeout(4000), headers: { "user-agent": BROWSER_UA, accept: "application/json" } });
    if (!res?.ok || !/json|javascript/i.test(res.headers.get("content-type") || "")) { res?.body?.cancel().catch(() => {}); return null; }
    const p = JSON.parse(await readCapped(res, 500_000));
    if (!p || !Array.isArray(p.variants)) return null;
    const want = url.searchParams.get("variant");
    const v = (want && p.variants.find((x) => String(x.id) === want)) || (p.variants.length === 1 ? p.variants[0] : null);
    // No variant picked and the variants cost different amounts: we can't tell which price they meant.
    const prices = new Set(p.variants.map((x) => x.price));
    const cents = Number(v ? v.price : prices.size === 1 ? p.price : NaN);
    return {
      price: Number.isFinite(cents) && cents > 0 ? Math.round(cents) / 100 : null,
      inStock: typeof (v ? v.available : p.available) === "boolean" ? (v ? v.available : p.available) : null,
    };
  } catch { return null; }
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
  const opened = openedPage(r.urlContext, url);
  let image = imageLink(d.image?.trim() || "");
  if (image && !(await isImage(image))) image = null;
  return { opened, title: decode(d.title).slice(0, LIMITS.title), price: toPrice(d.price), currency: currencyCode(d.currency), image, inStock: typeof d.in_stock === "boolean" ? d.in_stock : null,
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
// v4: drops cached answers from before currencies were converted.
const liveKey = (u) => new Request(`https://live-price.wishlist.invalid/v4/${encodeURIComponent(u)}`);
async function livePrice(env, rawUrl, { ai = true } = {}) {
  let clean;
  try { clean = cleanLink(await resolveShortLink(new URL(link(rawUrl)))); } catch { return null; }
  if (!clean) return null;
  try { const hit = await caches.default.match(liveKey(clean)); if (hit) return await hit.json(); } catch {}
  const url = new URL(clean);
  const site = url.hostname.replace(/^www\./, "");
  let price = null, inStock = null, via = "page", currency = null, guess = false;
  const shop = await shopifyProduct(url);
  if (shop && (shop.price != null || shop.inStock !== null)) {
    price = shop.price; inStock = shop.inStock; via = "shopify";
    if (price != null) currency = await shopifyCurrency(url, "");
  }
  const { html } = via === "shopify" ? { html: "" } : await readPage(url, 5000);
  if (html && !BOT_PAGE.test(decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) || "")) {
    const ld = jsonLdProduct(html);
    currency = pageCurrency(html, ld);
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
    // Gemini's price only counts when it really opened the page. From Google Search alone it has been wrong
    // (a $129 Coach bag came back as $275), so then only its stock status is used.
    if (found && matchesLink(found.title, url)) {
      inStock = found.inStock;
      if (found.opened) { price = found.price; currency = found.currency; via = "ai-page"; } else via = "search";
    }
  }
  ({ price, guess } = await inUsd(price, currency));
  const out = { price, inStock, site, via, guess, checkedAt: now() };
  const hit = price != null || inStock !== null;
  try {
    await caches.default.put(liveKey(clean), new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": `max-age=${hit ? LIVE_TTL : LIVE_MISS_TTL}` } }));
  } catch {}
  console.log(`live ${site} -> ${via}${price != null ? ` $${price}${guess ? ` (from ${currency})` : ""}` : ""}${inStock === false ? " out" : inStock ? " in" : ""}`);
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

  let title = null, price = null, siteName = null, image = null, brand = null, currency = null;
  if (html) {
    siteName = meta(html, "og:site_name");
    const ld = jsonLdProduct(html);
    currency = pageCurrency(html, ld);
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
  if (price == null && opts.shop?.price != null) { price = opts.shop.price; currency = await shopifyCurrency(url, html); }
  // Prices are shown in dollars; another currency is converted and flagged as an estimate.
  const conv = await inUsd(price, currency);
  price = conv.price;
  if (!imageUrl && opts.shop?.image && title) imageUrl = imageLink(opts.shop.image);
  let out = { url: finalUrl.toString(), title: title || guess, price, priceGuess: conv.guess, image: imageUrl, site, found: !!title, guessed: !title && !!guess,
    sizes: opts.sizes, colors: opts.colors, size: opts.size, color: opts.color, brand: tidyBrand(brand) };
  // The page gave us no name, photo or price (blocked, a bot check, or an empty shell): look it up. The page's own
  // details win; the lookup only fills what's missing.
  if (ai && (!title || !imageUrl || out.price == null)) {
    const found = await lookupLink(env, clean, [hint, slugGuess]).catch(() => null);
    if (found && (title || matchesLink(found.title, url))) {
      // Gemini's price is only an estimate unless it really opened the page (and even then if it's another currency).
      let fp = { price: null, guess: false };
      if (price == null && found.price != null) {
        fp = await inUsd(found.price, found.currency);
        if (!found.opened) fp.guess = true;
      }
      out = { ...out, title: title || found.title, price: price ?? fp.price, priceGuess: price != null ? out.priceGuess : fp.guess, image: imageUrl || found.image, found: true, guessed: false, via: "search",
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

// ---------- Add to Hints from the iPhone Share button (POST quickadd) ----------

// Turn "Check out Lip Oil on Ulta Beauty!" into "Lip Oil". Must match shareHint() in public/index.html.
function shareHint(t) {
  t = t.replace(/\s+/g, " ").trim()
    .replace(/^(hey[,!]?\s*)?(check (this|it) out|check out( this( product| item)?)?|look (at )?(what|this)( i found)?|i found this|found this|shop( now)?|buy( now)?)\s*(on|at|from)?\s*[:!.\-]*\s*/i, "")
    .replace(/(\s+(on|at|from|via)\s+|\s+[|\-–]\s+)[\w&'. ]{2,30}[!.]*$/i, (x) => (/\b(app|beauty|store|shop|amazon|target|walmart|sephora|ulta|etsy)\b/i.test(x) ? "" : x))
    .replace(/^[\w&'. ]{2,30}:\s*/, (x) => (/\b(app|beauty|store|shop|amazon|target|walmart|sephora|ulta|etsy)\b/i.test(x) ? "" : x))
    .replace(/^["'\s:!.\-([]+|["'\s:!.\-([]+$/g, "");
  return t.length >= 3 && t.length <= 150 && /[a-z]/i.test(t) ? t : "";
}

// What a Shortcut sends: JSON ({ text } or { url }), a form, or the shared text as the whole body.
async function sharedInput(req) {
  if (Number(req.headers.get("content-length") || 0) > 20_000) fail(413, "That's too much to send at once.");
  const raw = (await req.text().catch(() => "")).slice(0, 20_000);
  let b = {};
  try { const j = JSON.parse(raw); if (j && typeof j === "object") b = j; } catch {
    const form = new URLSearchParams(raw);
    b = form.has("text") || form.has("url") ? Object.fromEntries(form) : { text: raw };
  }
  const str = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : "");
  return { key: str(b.key), text: [str(b.url), str(b.text)].join(" ").replace(/\s+/g, " ").trim() };
}

async function quickAdd(req, env) {
  const input = await sharedInput(req);
  const key = (req.headers.get("x-hints-key") || input.key || "").trim();
  if (!/^hk_[A-Za-z0-9]{40}$/.test(key)) fail(401, "This Shortcut needs your add key. Get one in Hints: Settings > Add from the Share button.");
  const me = await env.DB.prepare("SELECT id, created_at FROM members WHERE add_key_hash = ?").bind(await sha256(key)).first();
  if (!me) fail(401, "That add key doesn't work anymore. Make a new one in Hints: Settings > Add from the Share button.");
  forScope(me);
  await rateLimit(env, `quickadd:${me.id}`, ABUSE.quickAddPerMember, "That's a lot of links for now. Try again in a bit.");

  const shared = input.text.slice(0, LIMITS.url + 300);
  if (!/(https?:\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)/i.test(shared)) fail(400, "No link in what you shared. Try sharing the product page.");
  const url = link(sharedUrl(shared).slice(0, LIMITS.url));
  const at = shared.indexOf(sharedUrl(shared));
  const hint = shareHint(at >= 0 ? `${shared.slice(0, at)} ${shared.slice(at + sharedUrl(shared).length)}` : "");

  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE owner_id = ? AND removed_at IS NULL").bind(me.id).first();
  if (n >= ABUSE.itemsPerMember) fail(409, `Your list is full (${ABUSE.itemsPerMember} wishes). Remove a few in Hints to add more.`);

  // Fill it in like the Fill button. Over the autofill limit (or if the store fights back), save the link with a guess.
  let p = null;
  try {
    const ai = await underLimit(env, `preview:${me.id}`, ABUSE.previewPerMember);
    p = await previewLink(env, url, { ai, hint: hint.slice(0, 150) });
  } catch (err) {
    console.log("quickadd preview failed", String(err?.message || err));
  }
  const saveUrl = p?.clean || url;
  const dupe = await env.DB.prepare("SELECT title, draft FROM items WHERE owner_id = ? AND url = ? AND removed_at IS NULL").bind(me.id, saveUrl).first();
  if (dupe) return `Already in Hints${dupe.draft ? " (in Maybe)" : ""}: ${dupe.title}`;

  const site = new URL(saveUrl).hostname.replace(/^www\./, "");
  // Share text beats a name guessed from the link, same as in the app.
  const title = ((p?.found && p.title) || hint || p?.title || `Something from ${site}`).replace(/\s+/g, " ").trim().slice(0, LIMITS.title);
  const price = p?.price != null ? cents(p.price) : null;
  const image = p?.image ? imageLink(p.image) : null;
  const t = now();
  const id = newId();
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO items (id, owner_id, title, url, price_cents, notes, priority, created_at, updated_at, image_url, image_checked_at, category, draft, details_v) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, 1, ?)`,
    // Not filled now (store blocked us, or over the limit): details_v 0 lets the app's details refresh try once more.
    ).bind(id, me.id, title, saveUrl, price, t, t, image, image ? t : null, p?.found ? DETAILS_V : 0),
    env.DB.prepare("UPDATE items SET price_auto = ?, quantity = 1, brand = ?, size = ?, color = ? WHERE id = ?")
      .bind(price != null ? (p.priceGuess ? 2 : 1) : 0, str(p?.brand, LIMITS.brand), str(p?.size, LIMITS.size), str(p?.color, LIMITS.color), id),
  ]);
  console.log(`quickadd ${site} -> ${p?.found ? "filled" : "guess"}`);
  return `Added to your Maybe list in Hints: ${title}`;
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
    const raw = ld.price ?? toPrice(meta(page, "product:price:amount", "og:price:amount"))
      ?? toPrice(page.match(/class=["']a-offscreen["'][^>]*>\s*\$?([\d,.]+)/i)?.[1]);
    const { price } = await inUsd(raw, pageCurrency(page, ld));
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
// The app couldn't read the link when it was saved (store slow, offline, over the limit): try it again in the
// background so the photo and price still show up without anyone typing them.
async function markUnfilled(env, table, id, b, url) {
  if (b.unfilled === true && url) await env.DB.prepare(`UPDATE ${table} SET details_v = 0 WHERE id = ?`).bind(id).run();
}
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
       price_cents = COALESCE(?4, price_cents), price_auto = CASE WHEN ?4 IS NOT NULL THEN ?10 ELSE price_auto END${extra}
      WHERE id = ?5 AND url IS ?6`,
  );
  const args = [DETAILS_V, image, t, price, row.id, row.url];
  args.push(...(table === "items" ? [ok ? p.brand || null : null, ok ? p.size || null : null, ok ? p.color || null : null] : [null, null, null]), p?.priceGuess ? 2 : 1);
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
const NOTIFY_KINDS = ["wishes", "birthdays", "groupGifts", "chat", "reminders", "feed"];
function notifyPrefs(v) {
  let o = {};
  try { o = JSON.parse(v || "{}") || {}; } catch {}
  // chatText (off unless turned on): put the message itself in chat notifications. Off, they just say
  // "New message about Sam", so nothing readable sits on a lock screen the person it's about might see.
  return { ...Object.fromEntries(NOTIFY_KINDS.map((k) => [k, o[k] !== false])), chatText: o.chatText === true };
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
        "SELECT COUNT(*) AS n, MAX(MAX(created_at, updated_at)) AS latest FROM items WHERE owner_id = ? AND draft = 0 AND removed_at IS NULL AND received_at IS NULL",
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
    const prefs = notifyPrefs(r.notify);
    const about = nicks.get(subjectId) || subject?.name || "someone";
    const text = msg.body.length > 140 ? `${msg.body.slice(0, 137)}...` : msg.body;
    await pushTo(env, r.id, {
      // Message text only for people who turned on "Show message text" (Settings > Notifications).
      title: prefs.chatText ? `${nicks.get(author.id) || author.name} in the chat about ${about}` : `New message about ${about}`,
      body: prefs.chatText ? text : "Tap to read it.",
      url: `/#person/${subjectId}/chat/${groupId}`, tag: `chat:${groupId}:${subjectId}`,
    });
  }
}

// ---------- problems and notes for whoever runs Hints ----------
// The owner is OWNER_ID (wrangler.jsonc vars) when it's set, otherwise the first person who ever joined (whoever
// set Hints up). Only they get notes, the problem list (Settings > Inbox) and the morning "problems" notification.
async function appOwner(env) {
  if (env.OWNER_ID) {
    const row = await env.DB.prepare("SELECT id, name FROM members WHERE id = ?").bind(String(env.OWNER_ID)).first();
    if (row) return row;
  }
  return env.DB.prepare("SELECT id, name FROM members WHERE managed_by IS NULL ORDER BY created_at, id LIMIT 1").first();
}
async function ownerOnly(env, me) {
  if ((await appOwner(env))?.id !== me.id) fail(404, "Not found.");
}
const clip = (v, n) => String(v ?? "").slice(0, n);
// Saves a problem the app or the API ran into. The same message from the same place is one row with a count,
// and a repeat reopens it if it was marked done. Never form contents: just the message, where, and the browser.
async function recordProblem(env, { where, message, detail = null, memberId = null }) {
  const msg = clip(message, 300).trim() || "Unknown problem";
  const sig = `e:${(await sha256(`${where}|${msg}`)).slice(0, 32)}`;
  const t = now();
  await env.DB.prepare(
    `INSERT INTO reports (id, kind, member_id, body, detail, sig, count, created_at, last_at) VALUES (?, 'error', ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (sig) DO UPDATE SET count = reports.count + 1, last_at = excluded.last_at, detail = excluded.detail,
       member_id = COALESCE(excluded.member_id, reports.member_id), done_at = NULL`,
  ).bind(newId(), memberId, `${where}: ${msg}`, detail ? clip(detail, 4000) : null, sig, t, t).run();
}
// Browser and app version lines for a report (no IP address).
const reportContext = (req, b) => [
  b.page && `Page: ${clip(b.page, 200)}`,
  b.version && `App version: ${clip(b.version, 80)}`,
  `Browser: ${clip(req.headers.get("user-agent"), 300)}`,
].filter(Boolean).join("\n");
// Morning run: one notification to the owner when problems came up in the last day (once a day).
async function problemPing(env, budget) {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE kind = 'error' AND done_at IS NULL AND last_at > ?").bind(since).first();
  if (!row?.n || budget.left <= 0) return 0;
  const owner = await appOwner(env);
  if (!owner || !(await onceOnly(env, `problems:${today()}`))) return 0;
  return deliver(env, owner.id, {
    title: `Hints ran into ${row.n === 1 ? "a problem" : `${row.n} problems`}`,
    body: "Tap to see what happened.", url: "/#settings/inbox", tag: "problems",
  }, budget);
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
    // Problems and notes: handled ones after 90 days, problems that stopped happening after 90 days.
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    await env.DB.prepare("DELETE FROM reports WHERE done_at < ?1 OR (kind = 'error' AND last_at < ?1)").bind(old).run().catch(() => {});
    await feedSweep(env).catch((err) => console.error("feed sweep", err));
  }
  await settleReceived(env).catch((err) => console.error("settle", err));
  await snapshotGifts(env).catch((err) => console.error("history", err));
  await pepperPins(env).catch((err) => console.error("pepper", err));
  const later = isQuiet(hour) ? 0 : await flushLater(env, budget).catch((err) => (console.error("later", err), 0));
  const wishes = await wishDigest(env, budget, hour).catch((err) => (console.error("digest", err), 0));
  // PUSH_DEV_REMIND: local testing only (.dev.vars), runs reminders every time.
  const remind = (hour >= 9 && !isQuiet(hour)) || env.PUSH_DEV_REMIND === "1" ? await reminders(env, budget).catch((err) => (console.error("reminders", err), 0)) : 0;
  const problems = hour >= 9 && !isQuiet(hour) ? await problemPing(env, budget).catch((err) => (console.error("problems", err), 0)) : 0;
  console.log(`schedule hour=${hour} later=${later} wishes=${wishes} reminders=${remind} problems=${problems} budget_left=${budget.left}`);
}

// Signing in as someone who is looked after isn't allowed until a manager hands their list over.
async function notManaged(env, member) {
  if (!member.managed_by) return;
  const by = await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(member.managed_by).first();
  fail(409, `${member.name}'s list is looked after by ${by?.name || "someone in this circle"}. Ask them to tap "Let ${member.name} sign in" on ${member.name}'s list first.`);
}

// ---------- passkeys (docs/plans/public-launch.md, migration 0046) ----------
// Sign in with Face ID or a fingerprint. The passkey lives in iCloud Keychain or Google Password Manager, so a new
// phone has it, which is how a solo person who lost their sign-in link and phone gets back in. Passkey sign-in
// skips the PIN (it's stronger than one). The relying party is whichever Hints domain the page is on.
const b64u = {
  from: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  to: (str) => Uint8Array.from(atob(String(str).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
};
const passkeyLabel = (req) => {
  const ua = req.headers.get("user-agent") || "";
  return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Computer" : "This device";
};
// The passkey's site (relying party) and the page origin to expect: this Worker's own host. (Local testing:
// `wrangler dev --local-upstream localhost:8787`, or wrangler hands the Worker the production hostname.)
function rpOf(env, req) {
  const url = new URL(req.url);
  return { id: url.hostname, origin: url.origin };
}
async function newChallenge(env, challenge, memberId = null) {
  const id = newToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM passkey_challenges WHERE expires < ?").bind(now()),
    env.DB.prepare("INSERT INTO passkey_challenges (id, challenge, member_id, expires) VALUES (?, ?, ?, ?)")
      .bind(id, challenge, memberId, new Date(Date.now() + 5 * 60_000).toISOString()),
  ]);
  return id;
}
// Uses up a challenge (one try each). Must belong to memberId (null when signing in).
async function takeChallenge(env, id, memberId = null) {
  const row = await env.DB.prepare("DELETE FROM passkey_challenges WHERE id = ? RETURNING challenge, member_id, expires").bind(String(id || "")).first();
  if (!row || row.expires < now() || (row.member_id || null) !== memberId) fail(400, "That took too long. Try again.");
  return row.challenge;
}
async function passkeysOf(env, memberId) {
  const { results } = await env.DB.prepare("SELECT id, label, created_at, last_used FROM passkeys WHERE member_id = ? ORDER BY created_at").bind(memberId).all();
  return results.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsed: r.last_used }));
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
      // People set up by someone else (managed) show as waiting: tapping their name takes the list over. Kids
      // someone looks after never show: they stay looked after until a manager hands them over.
      "SELECT m.id, m.name, m.last_name, m.household_id, m.pin_hash, m.photo_at, m.managed_by FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND (m.managed_by IS NULL OR m.is_kid = 0) ORDER BY m.name COLLATE NOCASE",
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
      group: { name: group.name, admin: results.find((m) => m.id === adminId)?.name || null, askToJoin: !!group.ask_to_join, linkClaims: !!group.link_claims },
      inviter: info?.inviter || null,
      members: results.map((m) => ({
        id: m.id, name: m.name, hasPin: !!m.pin_hash && !m.managed_by, photo: m.photo_at || null,
        // Set up by someone else and not claimed yet: tapping it makes the list theirs.
        waiting: !!m.managed_by, by: m.managed_by ? results.find((x) => x.id === m.managed_by)?.name || null : null,
        lastInitial: twice(m) && m.last_name ? m.last_name[0].toUpperCase() : null,
        household: twice(m) && !m.last_name ? hhTag.get(m.household_id) || null : null,
      })),
    };
  },

  // Step 2: sign in as an existing member (memberId + PIN) or add yourself (name + a new PIN).
  // Every person who signs in has a PIN, so the circle link alone never signs anyone in as someone else:
  // - Someone with a PIN: their PIN.
  // - A list set up for you ("Ready for you"), or someone whose PIN was cleared or who has never signed in: pick a
  //   new PIN now (428 until one is sent).
  // - Someone with no PIN who is already signed in somewhere else: refused (423). They set a PIN on that device
  //   first (the app asks everyone without one), or use their personal sign-in link.
  // A circle with Ask to join on puts new people on its admin's waiting list instead of straight in.
  async "POST join"(req, env) {
    const b = await body(req);
    await rateLimit(env, `join:ip:${ipOf(req)}`, ABUSE.joinPerIp, "Too many sign-in tries. Wait a bit and try again.");
    const group = await groupByCode(env, b.code);
    if (b.memberId) {
      const member = await env.DB.prepare(
        "SELECT m.id, m.name, m.pin_hash, m.pin_cleared_at, m.managed_by, m.is_kid FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND m.id = ?",
      )
        .bind(group.id, b.memberId)
        .first();
      if (!member) fail(404, "That person isn't in this circle.");
      // A list someone set up for you, opened from the circle link: it becomes yours (like a personal link), with
      // the PIN you pick now. Kids someone looks after can't be taken over this way.
      // Circles started after public sign-ups opened (groups.link_claims = 0) don't allow this: anyone holding the
      // circle code could take over a list that isn't theirs. The admin gets a nudge to send that person their own
      // link (the admin's OK, without a new approval flow). Older circles (link_claims = 1) work as before.
      if (member.managed_by && !member.is_kid && !group.link_claims) {
        const admin = await adminOf(env, group.id);
        const adminName = admin && (await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(admin).first())?.name;
        if (admin && (await hit(env, `claimask:${member.id}`, 3600)) === 1) {
          await pushTo(env, admin, {
            title: `${member.name} is trying to get into Hints`,
            body: "They opened the circle link. Send them their own link: Circles > Manage, then Invite next to their name.",
            url: "/#family", tag: `claimask:${member.id}`,
          }).catch((err) => console.error("claim ask push", err));
        }
        fail(403, `${adminName || "The circle's admin"} needs to send you your own link to get your list. We let them know.`);
      }
      if (member.managed_by && !member.is_kid) {
        const pin = pinValue(b.pin);
        if (!pin) fail(428, "Pick a 4-digit PIN so only you can sign in as you.");
        const done = await env.DB.prepare("UPDATE members SET managed_by = NULL, claim_expires = NULL, onboarded_at = NULL, pin_hash = ? WHERE id = ? AND managed_by IS NOT NULL")
          .bind(await hashPin(env, member.id, pin), member.id).run();
        if (!done.meta?.changes) fail(409, `${member.name} just joined. Go back and tap your name again.`);
        return { token: await signIn(env, member.id), claimed: true };
      }
      await notManaged(env, member);
      if (member.pin_hash) {
        await checkPin(env, req, member, b.pin, b.turnstile);
        return { token: await signIn(env, member.id) };
      }
      await setFirstPin(env, req, member, b.pin);
      return { token: await signIn(env, member.id) };
    }
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
    if (!pin) fail(428, "Pick a 4-digit PIN. You'll use it to sign in on a new phone.");
    await circleRoom(env, group.id);
    await newMemberAllowed(env, req);
    const id = newId();
    const t = now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO members (id, name, last_name, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, lastName, await hashPin(env, id, pin), t),
      group.ask_to_join
        ? env.DB.prepare("INSERT INTO join_requests (group_id, member_id, created_at) VALUES (?, ?, ?)").bind(group.id, id, t)
        : env.DB.prepare(JOIN_DIRECT).bind(group.id, id, t),
    ]);
    if (group.ask_to_join) await askedToJoin(env, group, name);
    return { token: await signIn(env, id), pending: !!group.ask_to_join };
  },

  // Start on Hints. With groupName: a new circle, its join code, and you as its first member. Without it: just you
  // and your list (no circle yet), plus your personal sign-in link, since there's no circle to tap your name in on a
  // new phone. Returns { token, link? }.
  async "POST start"(req, env) {
    const b = await body(req);
    if (!String(b.groupName || "").trim()) return startSolo(req, env, b);
    const groupName = text(b.groupName, LIMITS.group, "Circle name", true);
    const name = text(b.name, LIMITS.name, "Your first name", true);
    const lastName = lastNameOf(b.lastName);
    const pin = pinValue(b.pin);
    if (!pin) fail(428, "Pick a 4-digit PIN. You'll use it to sign in on a new phone.");
    await rateLimit(env, `start:ip:${ipOf(req)}`, ABUSE.startPerIp, "Too many new circles from here today. Try again tomorrow.");
    if ((await hit(env, "newcircle:all", 86400)) > ABUSE.newCirclesPerDay) fail(429, "Hints isn't taking new circles right now. Try again tomorrow.");
    await newMemberAllowed(env, req);
    const groupId = newId();
    const memberId = newId();
    const t = now();
    const code = await newUniqueJoinCode(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO groups (id, name, join_code, created_at, link_claims) VALUES (?, ?, ?, ?, 0)").bind(groupId, groupName, code, t),
      env.DB.prepare("INSERT INTO members (id, name, last_name, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        memberId,
        name,
        lastName,
        await hashPin(env, memberId, pin),
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
      "SELECT g.id, g.name, g.join_code, g.created_by, g.photo_at, g.ask_to_join FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.member_id = ? ORDER BY gm.joined_at",
    )
      .bind(me.id)
      .all();
    const { results: people } = await env.DB.prepare(
      `SELECT gm.group_id, m.id, m.name, m.last_name, m.photo_at, m.birthday, m.household_id, m.dislikes, m.owns, m.is_kid, m.managed_by, m.claim_hash IS NOT NULL AS has_link, m.pin_hash IS NOT NULL AS has_pin,
              (SELECT COUNT(*) FROM items i WHERE i.owner_id = m.id AND i.removed_at IS NULL AND i.draft = 0 AND i.held_season IS NULL AND i.received_at IS NULL
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
    // For circle admins only: who's signed in somewhere and who has notifications on, so Manage can show who
    // still needs a hand getting set up. Nothing about when or how often anyone uses the app.
    const setup = new Map();
    if (adminCircles.size) {
      const { results } = await env.DB.prepare(
        `SELECT DISTINCT gm.member_id AS id,
                EXISTS (SELECT 1 FROM devices d WHERE d.member_id = gm.member_id) AS signed_in,
                EXISTS (SELECT 1 FROM push_subs s WHERE s.member_id = gm.member_id AND ${LIVE_SUB}) AS push_on
           FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE g.created_by = ?`,
      ).bind(me.id).all();
      for (const r of results) setup.set(r.id, { signedIn: !!r.signed_in, push: !!r.push_on });
    }
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
      inviteSent: manages(p) && !!p.has_link,
      // Unread messages in the chat about them in this circle. Always 0 for yourself (chatUnread skips your thread).
      chatUnread: p.id === me.id ? 0 : unread.get(`${p.group_id}:${p.id}`) || 0,
      // Circle admins only (see setup above): { signedIn, push }.
      ...(adminCircles.has(p.group_id) && setup.has(p.id) ? { setup: setup.get(p.id) } : {}),
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
          ? env.DB.prepare("SELECT id, name, photo_at, pin_hash IS NOT NULL AS has_pin, managed_by IS NULL AS uses_app FROM members WHERE household_id = ? ORDER BY name COLLATE NOCASE").bind(myHh).all()
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
            members: list.map((p) => ({ id: p.id, name: p.id === me.id ? me.name : nicks.get(p.id) || p.name, photo: p.photo_at || null, hasPin: !!p.has_pin, usesApp: !!p.uses_app })),
          };
        }
      }
    }
    // Pets of every household above, and of people (you included) who aren't in a household.
    const solo = [...new Set([...people.filter((p) => !p.household_id).map((p) => p.id), ...(myHh ? [] : [me.id])])];
    const pets = await petsFor(env, Object.keys(households), solo);
    let pinCleared = null;
    const owner = await appOwner(env);
    const isOwner = owner?.id === me.id;
    const openReports = isOwner
      ? (await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE done_at IS NULL").first())?.n || 0
      : 0;
    const prefsRow = await env.DB.prepare("SELECT notify, stale_ok_year, share_token, created_at, claim_hash IS NOT NULL AS has_link, add_key_hash IS NOT NULL AS has_add_key FROM members WHERE id = ?").bind(me.id).first();
    const { results: seenRows } = await env.DB.prepare("SELECT owner_id, seen_count FROM list_seen WHERE viewer_id = ?").bind(me.id).all();
    // Circles you asked to join and are waiting on, and (for circles you run) who's waiting on you.
    const { results: pendingRows } = await env.DB.prepare(
      "SELECT g.id, g.name, g.created_by FROM join_requests r JOIN groups g ON g.id = r.group_id WHERE r.member_id = ? ORDER BY r.created_at",
    ).bind(me.id).all();
    const pending = [];
    for (const g of pendingRows) {
      const a = await adminOf(env, g.id);
      const admin = a && (await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(a).first());
      pending.push({ id: g.id, name: g.name, admin: admin?.name || null });
    }
    const runIds = groups.filter((g) => g.created_by === me.id).map((g) => g.id);
    const { results: reqRows } = runIds.length
      ? await env.DB.prepare(
        `SELECT r.group_id, r.created_at, m.id, m.name, m.last_name FROM join_requests r JOIN members m ON m.id = r.member_id
          WHERE r.group_id IN (${runIds.map(() => "?").join(",")}) ORDER BY r.created_at`,
      ).bind(...runIds).all()
      : { results: [] };
    // Household requests (migration 0044): ones asking you, and ones you can see waiting on someone (that you sent,
    // for your household, or for a household in a circle you run).
    const { results: askRows } = await env.DB.prepare(
      `SELECT r.id, r.household_id, r.invited_by, m.name AS by_name FROM household_requests r JOIN members m ON m.id = r.invited_by
        WHERE r.member_id = ? ORDER BY r.created_at`,
    ).bind(me.id).all();
    const householdInvites = [];
    for (const r of askRows) {
      const hhId = r.household_id || (await householdOf(env, r.invited_by));
      const { results: inIt } = hhId
        ? await env.DB.prepare("SELECT id, name FROM members WHERE household_id = ? ORDER BY name COLLATE NOCASE").bind(hhId).all()
        : { results: [] };
      const hhName = hhId ? (await env.DB.prepare("SELECT name FROM households WHERE id = ?").bind(hhId).first())?.name : null;
      const ppl = inIt.length ? inIt : [{ id: r.invited_by, name: r.by_name }];
      householdInvites.push({
        id: r.id,
        by: nicks.get(r.invited_by) || r.by_name,
        label: householdLabel(hhName, ppl.map((p) => nicks.get(p.id) || p.name)),
        people: ppl.map((p) => ({ id: p.id, name: nicks.get(p.id) || p.name })),
      });
    }
    const { results: sentRows } = await env.DB.prepare(
      `SELECT r.id, r.member_id, r.household_id, m.name FROM household_requests r JOIN members m ON m.id = r.member_id
        WHERE r.invited_by = ?1 OR (r.household_id IS NOT NULL AND (r.household_id = ?2
           OR r.household_id IN (SELECT gh.household_id FROM group_households gh JOIN groups g ON g.id = gh.group_id WHERE g.created_by = ?1)))
        ORDER BY r.created_at`,
    ).bind(me.id, myHh || "").all();
    const householdAsks = sentRows.map((r) => ({ id: r.id, memberId: r.member_id, name: nicks.get(r.member_id) || r.name, householdId: r.household_id || myHh || null }));
    if (me.pinClearedAt) {
      const by = me.pinClearedBy && (await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(me.pinClearedBy).first());
      pinCleared = { by: (by && (nicks.get(me.pinClearedBy) || by.name)) || "Someone", at: me.pinClearedAt };
    }
    return {
      me: {
        id: me.id, name: me.name, lastName: me.lastName, hasPin: me.hasPin, onboarded: me.onboarded, photo: people.find((p) => p.id === me.id)?.photo_at || (await env.DB.prepare("SELECT photo_at FROM members WHERE id = ?").bind(me.id).first())?.photo_at || null,
        // Someone cleared your forgotten PIN (see "POST pin/clear"). Shown once as a notice.
        pinCleared,
        profile: await profileOf(env, me.id), household: myHousehold,
        // Requests to join a household waiting on you, and ones you can see waiting on others.
        householdInvites, householdAsks,
        notify: notifyPrefs(prefsRow?.notify),
        // Year "Looks good" was tapped on the "hasn't changed since last year" card.
        staleOk: prefsRow?.stale_ok_year || null,
        // Your read-only share link (/s/TOKEN), or null when it's off.
        shareToken: prefsRow?.share_token || null,
        // You have a personal sign-in link (it can't be shown again, only replaced or turned off).
        hasLink: !!prefsRow?.has_link,
        // You have an add key for the iPhone Shortcut (also can't be shown again).
        hasAddKey: !!prefsRow?.has_add_key,
        // Passkeys (Settings) and what the "save a passkey" nudge needs: signed-in devices and account age.
        passkeys: await passkeysOf(env, me.id),
        devices: (await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE member_id = ?").bind(me.id).first())?.n || 0,
        since: prefsRow?.created_at || null,
      },
      // Whoever runs Hints (appOwner): their name for "Send Alexis a note", and for them, the Inbox's open count.
      owner: owner ? { name: owner.id === me.id ? me.name : nicks.get(owner.id) || owner.name, you: isOwner, open: openReports } : null,
      // How many wishes each person's list had when you last opened it, for the "N new" badges (any device).
      seen: Object.fromEntries(seenRows.map((r) => [r.owner_id, r.seen_count])),
      today: t,
      households,
      pets,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        code: g.join_code,
        createdBy: g.created_by || null, // the circle's admin
        photo: g.photo_at || null,
        askToJoin: !!g.ask_to_join,
        // People waiting to be let in (only for the circle's admin).
        requests: reqRows.filter((r) => r.group_id === g.id).map((r) => ({ id: r.id, name: r.name, lastName: r.last_name || null, at: r.created_at })),
        members: people.filter((p) => p.group_id === g.id).map(person).sort(byName),
      })),
      pending,
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

  // ---------- activity feed (Circles tab, docs/plans/activity-feed.md) ----------
  // Newest cards first. before: the `next` cursor from the last page. Cards whose wishes all went out of view are
  // skipped, so a page can come back with fewer than 20 while there's still more.
  async "GET feed"(req, env, url) {
    const me = await auth(req, env);
    const before = url.searchParams.get("before") || "9999";
    const { results } = await env.DB.prepare(
      `SELECT f.* FROM feed f WHERE ${FEED_SEES} AND f.updated_at < ?2 AND f.updated_at > ?3 ORDER BY f.updated_at DESC LIMIT ${FEED_PAGE + 1}`,
    ).bind(me.id, String(before), feedCutoff()).all();
    const page = results.slice(0, FEED_PAGE);
    return { cards: await feedCards(env, me.id, page), next: results.length > FEED_PAGE ? page[page.length - 1].updated_at : null, emoji: FEED_EMOJI };
  },

  // { body, shareId?, groupId? }. groupId: just that circle (one of yours); absent = all your circles.
  // Sharing a card is allowed with no text. Posts can't be shared again.
  async "POST feed/post"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const share = b.shareId ? await feedRowFor(env, me.id, b.shareId) : null;
    if (share?.kind === "post") fail(400, "Posts can't be shared again.");
    const msg = text(b.body, LIMITS.chat, "Post", !share);
    let groupId = null;
    if (b.groupId) {
      if (!(await myGroupIds(env, me.id)).includes(String(b.groupId))) fail(400, "Pick one of your circles.");
      groupId = String(b.groupId);
    }
    await rateLimit(env, `feed:p:${me.id}`, ABUSE.feedPostsPerMember);
    const id = newId(), t = now();
    await env.DB.prepare("INSERT INTO feed (id, actor_id, kind, group_id, body, share_id, created_at, updated_at) VALUES (?, ?, 'post', ?, ?, ?, ?, ?)")
      .bind(id, me.id, groupId, msg || null, share?.id || null, t, t).run();
    const row = await env.DB.prepare("SELECT * FROM feed WHERE id = ?").bind(id).first();
    return { card: (await feedCards(env, me.id, [row]))[0] };
  },

  // Fix your own post. { id, body }
  async "POST feed/edit"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const r = await feedRowFor(env, me.id, b.id);
    if (r.actor_id !== me.id || r.kind !== "post") fail(404, "That post isn't there anymore.");
    const msg = text(b.body, LIMITS.chat, "Post", !r.share_id);
    await env.DB.prepare("UPDATE feed SET body = ?, edited_at = ? WHERE id = ?").bind(msg || null, now(), r.id).run();
    const row = await env.DB.prepare("SELECT * FROM feed WHERE id = ?").bind(r.id).first();
    return { card: (await feedCards(env, me.id, [row]))[0] };
  },

  // Take one of your cards off the feed (a post, or an automatic one you'd rather not show). { id }
  async "POST feed/delete"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const r = await feedRowFor(env, me.id, b.id);
    if (r.actor_id !== me.id) fail(403, "You can only remove your own posts.");
    await env.DB.prepare("UPDATE feed SET deleted_at = ? WHERE id = ?").bind(now(), r.id).run();
    return { ok: true };
  },

  // { id, emoji }: one reaction per person. The same emoji again, or null, takes it back.
  async "POST feed/react"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const r = await feedRowFor(env, me.id, b.id);
    const cur = await env.DB.prepare("SELECT emoji FROM feed_reactions WHERE feed_id = ? AND member_id = ?").bind(r.id, me.id).first();
    const emoji = b.emoji == null || b.emoji === cur?.emoji ? null : String(b.emoji);
    if (emoji && !FEED_EMOJI.includes(emoji)) fail(400, "Pick one of the reactions.");
    if (emoji) {
      await env.DB.prepare(
        "INSERT INTO feed_reactions (feed_id, member_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (feed_id, member_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at",
      ).bind(r.id, me.id, emoji, now()).run();
    } else {
      await env.DB.prepare("DELETE FROM feed_reactions WHERE feed_id = ? AND member_id = ?").bind(r.id, me.id).run();
    }
    return { card: (await feedCards(env, me.id, [r]))[0] || null };
  },

  // Who reacted to a card (people you share a circle with).
  async "GET feed/reactions"(req, env, url) {
    const me = await auth(req, env);
    const r = await feedRowFor(env, me.id, url.searchParams.get("id"));
    const { results } = await env.DB.prepare(
      `SELECT x.member_id, x.emoji, m.name FROM feed_reactions x JOIN members m ON m.id = x.member_id
        WHERE x.feed_id = ?2 AND ${FEED_KNOWS("x.member_id")} ORDER BY x.created_at`,
    ).bind(me.id, r.id).all();
    const nicks = await nicknamesFor(env, me.id);
    return { people: results.map((x) => ({ id: x.member_id, name: x.member_id === me.id ? "You" : nicks.get(x.member_id) || x.name, emoji: x.emoji })) };
  },

  async "GET feed/comments"(req, env, url) {
    const me = await auth(req, env);
    const r = await feedRowFor(env, me.id, url.searchParams.get("id"));
    return { comments: await feedCommentsFor(env, me.id, r) };
  },

  // { id, body }
  async "POST feed/comment"(req, env, url, ctx) {
    const me = await auth(req, env);
    const b = await body(req);
    const r = await feedRowFor(env, me.id, b.id);
    const msg = text(b.body, LIMITS.chat, "Comment", true);
    await rateLimit(env, `feed:c:${me.id}`, ABUSE.feedCommentsPerMember);
    await env.DB.prepare("INSERT INTO feed_comments (id, feed_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(newId(), r.id, me.id, msg, now()).run();
    ctx?.waitUntil(feedCommented(env, me, r, msg).catch((err) => console.error("feed push", err)));
    return { comments: await feedCommentsFor(env, me.id, r) };
  },

  // Your own comment, or any comment on your card. { id }
  async "POST feed/comment/delete"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const c = await env.DB.prepare("SELECT id, feed_id, author_id FROM feed_comments WHERE id = ? AND deleted_at IS NULL").bind(String(b.id || "")).first();
    if (!c) fail(404, "That comment isn't there anymore.");
    const r = await feedRowFor(env, me.id, c.feed_id);
    if (c.author_id !== me.id && r.actor_id !== me.id) fail(403, "You can only remove your own comments.");
    await env.DB.prepare("UPDATE feed_comments SET deleted_at = ?, body = '' WHERE id = ?").bind(now(), c.id).run();
    return { comments: await feedCommentsFor(env, me.id, r) };
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
      await settleReceived(env, me.id);
      const { results: all } = await env.DB.prepare(
        "SELECT * FROM items WHERE owner_id = ? AND removed_at IS NULL ORDER BY draft, (priority = 'must') DESC, created_at",
      )
        .bind(me.id)
        .all();
      const results = all.filter((r) => !r.received_at);
      const ownLinks = linkInfo(all, null).links;
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
          goesWith: ownLinks.get(r.id) || [],
        })),
        // Just the brands. Who is giving one never comes back to the owner.
        giftCards: cards.filter((c) => GIFT_CARD_NAMES.has(c.brand)).map((c) => ({ brand: c.brand })),
        received: receivedOut(all),
      };
    }

    const t = today();
    // Hold anything from an occasion that just passed before anyone shops from it.
    await settleReceived(env, memberId);
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
    // Linked wishes: one whose partner this viewer can't see (a draft, hidden from their circles) stays out,
    // unless they already marked it.
    const { results: linkRows } = await env.DB.prepare(`SELECT ${LINK_COLS}, ${ITEM_VISIBLE} AS vis FROM items i WHERE i.owner_id = ?`)
      .bind(me.id, memberId)
      .all();
    const link = linkInfo(linkRows, new Set(linkRows.filter((r) => r.vis).map((r) => r.id)));
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
      // Someone you look after: their share link, if it's on.
      shareToken: manage ? (await env.DB.prepare("SELECT share_token FROM members WHERE id = ?").bind(memberId).first())?.share_token || null : undefined,
      // Someone you look after: their received wishes, and held ones waiting on "Did you get this?".
      ...(manage ? await (async () => {
        const { results: mine } = await env.DB.prepare("SELECT * FROM items WHERE owner_id = ? AND removed_at IS NULL AND (received_at IS NOT NULL OR held_season IS NOT NULL)").bind(memberId).all();
        return { received: receivedOut(mine), held: mine.filter((r) => r.held_season).map((r) => ({ id: r.id, title: r.title, held: r.held_season })) };
      })() : {}),
      giftCards: await giftCardsFor(env, memberId, me.id),
      items: results
        .filter((r) => !link.blocked.has(r.id) || marks.some((c) => c.item_id === r.id && c.buyer_id === me.id))
        .map((r) => ({
          ...itemOut(r),
          removed: !!r.removed_at,
          ...giftOut(r, marks.filter((c) => c.item_id === r.id), me.id, nicks),
          goesWith: link.links.get(r.id) || [],
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
      await markUnfilled(env, "items", b.id, b, fields[1]);
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
    await markUnfilled(env, "items", id, b, fields[1]);
    if (!isDraft) await feedWish(env, owner, id);
    return { id };
  },

  // Link one of your wishes to another ("Goes with"). kind: "together" (all or nothing: joins with's bundle,
  // or starts one), "needs" (only wanted along with `with`, one way), or null to unlink.
  // as: someone you look after.
  async "POST item/link"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const owner = await ownerFor(env, me, b.as);
    const mine = (id) => env.DB.prepare("SELECT id, bundle_id, needs_id FROM items WHERE id = ? AND owner_id = ? AND removed_at IS NULL").bind(String(id || ""), owner).first();
    const item = await mine(b.id);
    if (!item) fail(404, "Item not found.");
    const kind = b.kind === "together" || b.kind === "needs" ? b.kind : null;
    const other = kind ? await mine(b.with) : null;
    if (kind && (!other || other.id === item.id)) fail(400, "Pick another wish on the list.");
    if (kind === "needs" && other.needs_id === item.id) fail(400, "That one is already only wanted with this. Pick Both or neither instead.");
    const rows = [];
    if (kind === "together") {
      const bundle = other.bundle_id || newId();
      rows.push(
        env.DB.prepare("UPDATE items SET bundle_id = ?, needs_id = NULL WHERE id = ?").bind(bundle, item.id),
        env.DB.prepare("UPDATE items SET bundle_id = ? WHERE id = ?").bind(bundle, other.id),
      );
      // Two wishes can't be both "only with each other" and together; together wins.
      if (other.needs_id === item.id) rows.push(env.DB.prepare("UPDATE items SET needs_id = NULL WHERE id = ?").bind(other.id));
    } else {
      rows.push(env.DB.prepare("UPDATE items SET bundle_id = NULL, needs_id = ? WHERE id = ?").bind(kind ? other.id : null, item.id));
    }
    if (item.bundle_id) rows.push(bundleCleanup(env, item.bundle_id));
    await env.DB.batch(rows);
    return { ok: true };
  },

  // Publish one of your "Maybe" items to your wish list. Undo with item/unpublish.
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
    await feedWish(env, me.id, String(id));
    return { ok: true };
  },

  // Move one of your published wishes back to "Maybe" (drafts only you can see) instead of removing it.
  // Top pick is dropped (it only applies to published wishes). Anyone who already marked it keeps seeing it,
  // the same as a wish hidden from their circle. Held and received wishes stay where they are.
  async "POST item/unpublish"(req, env) {
    const me = await auth(req, env);
    const { id } = await body(req);
    const res = await env.DB.prepare(
      `UPDATE items SET draft = 1, priority = NULL, updated_at = ?
        WHERE id = ? AND owner_id = ? AND removed_at IS NULL AND draft = 0 AND held_season IS NULL AND received_at IS NULL`,
    )
      .bind(now(), String(id || ""), me.id)
      .run();
    if (!res.meta.changes) fail(404, "Item not found or already in Maybe.");
    return { ok: true };
  },

  // Remove one of your items. If someone already bought it, keep it for them (flagged "removed").
  // "Did you get this?" for held wishes. got: true = received, false = still want it (back on the list).
  // all: true answers every held wish at once. as: someone you look after.
  async "POST item/got"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const owner = await ownerFor(env, me, b.as);
    const where = b.all ? "owner_id = ? AND held_season IS NOT NULL" : "owner_id = ? AND held_season IS NOT NULL AND id = ?";
    const args = b.all ? [owner] : [owner, String(b.id || "")];
    const res = await env.DB.prepare(
      b.got
        ? `UPDATE items SET received_at = ?, received_season = held_season, settled_season = held_season, held_season = NULL WHERE ${where}`
        : `UPDATE items SET settled_season = held_season, held_season = NULL WHERE ${where}`,
    ).bind(...(b.got ? [now()] : []), ...args).run();
    if (!b.all && !res.meta.changes) fail(404, "Item not found.");
    return { ok: true, count: res.meta.changes };
  },

  // The Thanked check on a received wish.
  async "POST item/thanked"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const owner = await ownerFor(env, me, b.as);
    const res = await env.DB.prepare("UPDATE items SET thanked_at = ? WHERE id = ? AND owner_id = ? AND received_at IS NOT NULL")
      .bind(b.on ? now() : null, String(b.id || ""), owner).run();
    if (!res.meta.changes) fail(404, "Item not found.");
    return { ok: true };
  },

  // Put a received wish back on the list (it isn't asked about again for that occasion).
  async "POST item/unreceive"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const owner = await ownerFor(env, me, b.as);
    const res = await env.DB.prepare("UPDATE items SET received_at = NULL, received_season = NULL, thanked_at = NULL WHERE id = ? AND owner_id = ? AND received_at IS NOT NULL")
      .bind(String(b.id || ""), owner).run();
    if (!res.meta.changes) fail(404, "Item not found.");
    return { ok: true };
  },

  async "POST item/remove"(req, env) {
    const me = await auth(req, env);
    const { id, as } = await body(req);
    const owner = await ownerFor(env, me, as);
    const item = await env.DB.prepare("SELECT id FROM items WHERE id = ? AND owner_id = ? AND removed_at IS NULL")
      .bind(id, owner)
      .first();
    if (!item) fail(404, "Item not found.");
    // Any mark, past or upcoming, keeps the wish (removed) so gift history and buyers' views survive.
    // Leaves its bundle (the rest stay together). Wishes only wanted with this one stay hidden from others
    // until the owner unlinks them (their own card says "Only with a removed wish").
    const { bundle_id: bundle } = await env.DB.prepare("SELECT bundle_id FROM items WHERE id = ?").bind(id).first();
    if (bundle) await env.DB.batch([env.DB.prepare("UPDATE items SET bundle_id = NULL WHERE id = ?").bind(id), bundleCleanup(env, bundle)]);
    const claimed = await env.DB.prepare("SELECT 1 FROM claims WHERE item_id = ?").bind(id).first();
    if (claimed) await snapshotGifts(env);
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
    const b0 = await body(req);
    // An app still open from before the invite endpoint moved to invite/claim (it has no itemId).
    if (b0.token && !b0.itemId) return handlers["POST invite/claim"](new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(b0) }), env);
    const me = await auth(req, env);
    const { itemId, on, price, occasion, qty, chipIn } = b0;
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
      if (item.removed_at && rows.length === 1 && !(await env.DB.prepare("SELECT 1 FROM claims WHERE item_id = ?").bind(itemId).first())) {
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
    await markUnfilled(env, "private_ideas", id, b, fields[1]);
    // "I bought this" on your own idea is the same as marking it purchased.
    if (b.bought !== undefined) await setIdeaClaim(env, me, id, !!b.bought, b.paid, b.occasion);
    return { id };
  },

  async "POST idea/remove"(req, env) {
    const me = await auth(req, env);
    const { id } = await body(req);
    const idea = await env.DB.prepare("SELECT id FROM private_ideas WHERE id = ? AND author_id = ?").bind(id, me.id).first();
    if (!idea) fail(404, "Idea not found.");
    // Past purchases of it go into gift history first.
    if (await env.DB.prepare("SELECT 1 FROM idea_claims WHERE idea_id = ? AND season < ?").bind(id, today()).first()) await snapshotGifts(env);
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
         price_auto = CASE WHEN price_cents IS NULL AND ?3 IS NOT NULL THEN ?6 ELSE price_auto END,
         price_cents = CASE WHEN price_cents IS NULL THEN ?3 ELSE price_cents END
        WHERE id = ?4 AND url IS ?5`,
    ).bind(image, now(), price, row.id, row.url, needPrice && preview.priceGuess ? 2 : 1).run();
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
        if (p && (p.price != null || p.inStock !== null)) prices[key] = { price: p.price, inStock: p.inStock, site: p.site, guess: !!p.guess, checkedAt: p.checkedAt };
        // A price that came from the link follows the store. Hand-typed prices are never touched.
        const cur = p?.price != null ? Math.round(p.price * 100) : null;
        // A jump of more than half either way is more likely a misread than a real change: say "check the price"
        // instead of "Now $X", and don't save it.
        const odd = cur != null && row.price_cents > 0 && (cur > row.price_cents * 1.5 || cur < row.price_cents * 0.5);
        if (odd) prices[key].odd = true;
        // Only exact prices sync; an exact one also clears a saved estimate (price_auto 2 -> 1).
        if (cur != null && !odd && !p.guess && row.price_auto && (cur !== row.price_cents || row.price_auto === 2)) {
          const table = key.startsWith("item:") ? "items" : "private_ideas";
          await env.DB.prepare(`UPDATE ${table} SET price_cents = ?, price_auto = 1 WHERE id = ? AND url IS ? AND price_auto IN (1, 2)`)
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
  // Gifts given for occasions that have passed, newest first: yours, plus your household's for people outside
  // it (the same rule as shared budgets). member: only gifts for them.
  async "GET history"(req, env, url) {
    const me = await auth(req, env);
    const member = url.searchParams.get("member");
    const myHh = await householdOf(env, me.id);
    const team = await givers(env, me, myHh);
    const ids = team.map((x) => x.id);
    const { results } = await env.DB.prepare(
      `SELECT h.*, s.name AS subject_name, s.household_id, b.name AS buyer_name FROM gift_history h
         JOIN members s ON s.id = h.subject_id JOIN members b ON b.id = h.buyer_id
        WHERE h.buyer_id IN (${ids.map(() => "?").join(",")}) ${member ? "AND h.subject_id = ?" : ""}
        ORDER BY h.season DESC, s.name COLLATE NOCASE, h.created_at`,
    ).bind(...ids, ...(member ? [String(member)] : [])).all();
    const nicks = await nicknamesFor(env, me.id);
    return {
      gifts: results
        .filter((r) => r.buyer_id === me.id || sharesBudget(myHh, r))
        .map((r) => ({
          kind: r.kind, id: r.ref_id, season: r.season, subjectId: r.subject_id, subjectName: nicks.get(r.subject_id) || r.subject_name,
          title: r.kind === "card" ? `${GIFT_CARD_NAMES.get(r.title) || r.title} gift card` : r.title,
          url: r.url, image_url: r.image_url, spent_cents: r.spent_cents, qty: r.qty, chipIn: !!r.chip_in,
          by: r.buyer_id === me.id ? null : nicks.get(r.buyer_id) || r.buyer_name,
        })),
    };
  },

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
    if (group.ask_to_join) {
      await env.DB.prepare("INSERT OR IGNORE INTO join_requests (group_id, member_id, created_at) VALUES (?, ?, ?)").bind(group.id, me.id, now()).run();
      await askedToJoin(env, group, me.name);
      return { group: { id: group.id, name: group.name }, pending: true };
    }
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
      env.DB.prepare("INSERT INTO groups (id, name, join_code, created_at, created_by, link_claims) VALUES (?, ?, ?, ?, ?, 0)").bind(id, name, code, t, me.id),
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
    if (b.askToJoin !== undefined) rows.push(env.DB.prepare("UPDATE groups SET ask_to_join = ? WHERE id = ?").bind(b.askToJoin ? 1 : 0, g.id));
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
  // If it was their only circle they keep their list on their own (no circle), still signed in.
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
    await env.DB.batch([
      env.DB.prepare("DELETE FROM group_members WHERE group_id = ? AND member_id = ?").bind(groupId, memberId),
      env.DB.prepare("DELETE FROM item_hidden WHERE group_id = ? AND item_id IN (SELECT id FROM items WHERE owner_id = ?)").bind(groupId, memberId),
    ]);
    return { ok: true };
  },

  // Leave a circle (your last one too). Your list stays; that circle just stops seeing it.
  async "POST family/leave"(req, env) {
    const me = await auth(req, env);
    const { groupId } = await body(req);
    const mine = await myGroupIds(env, me.id);
    if (!mine.includes(groupId)) fail(404, "Circle not found.");
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
    for (const k of [...NOTIFY_KINDS, "chatText"]) if (b[k] !== undefined) prefs[k] = !!b[k];
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
          petsInto(env, id, to.household_id),
          env.DB.prepare(
            "INSERT INTO group_members (group_id, member_id, joined_at, direct) SELECT group_id, ?, ?, 0 FROM group_households WHERE household_id = ? ON CONFLICT DO NOTHING",
          ).bind(id, now(), to.household_id),
        ]);
        await budgetsOnJoin(env, id, to.household_id);
      }
    }
    await env.DB.prepare("UPDATE members SET managed_by = ?, claim_hash = NULL, claim_expires = NULL WHERE id = ?").bind(to.id, id).run();
    return { ok: true, name: to.name };
  },

  // A personal link for someone who isn't on Hints yet. Opening it signs them in as themselves and hands the list
  // over (invite/claim), so there's no shared PIN and they don't pick their name. It keeps working as their
  // sign-in link on new phones. A new link replaces the old one. Returns { token }; the app builds
  // /join/CODE?from=ME&hi=TOKEN.
  async "POST managed/invite"(req, env) {
    const me = await auth(req, env);
    const { memberId } = await body(req);
    if (!(await canManage(env, me.id, memberId))) fail(404, "Person not found.");
    await rateLimit(env, `invite:m:${me.id}`, ABUSE.invitesPerMemberDay, "That's a lot of invites today. Try again tomorrow.");
    const token = newLinkToken();
    await env.DB.prepare("UPDATE members SET claim_hash = ?, claim_expires = NULL WHERE id = ?").bind(await sha256(token), String(memberId)).run();
    return { token, expires: null };
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
    const by = them.managed_by ? await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(them.managed_by).first() : null;
    const { results: wishes } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM items WHERE owner_id = ? AND removed_at IS NULL AND draft = 0 AND received_at IS NULL",
    ).bind(them.id).all();
    const { results: circles } = await env.DB.prepare(
      "SELECT g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.member_id = ? ORDER BY gm.joined_at",
    ).bind(them.id).all();
    // returning: they've used their link before, so this signs them in again (pin: asks for their PIN first).
    const returning = !them.managed_by;
    return { id: them.id, name: them.name, by: by?.name || null, wishes: wishes[0]?.n || 0, circles: circles.map((c) => c.name), returning, pin: returning && !!them.pin_hash, needPin: !them.pin_hash };
  },

  // Use a personal link. The first time, the list becomes theirs and they get the welcome tour (which offers a
  // PIN). After that it signs them in again on this device, asking for their PIN if they set one. The link keeps
  // working. { token, pin? } Returns { token, name, returning }.
  async "POST invite/claim"(req, env) {
    const b = await body(req);
    await rateLimit(env, `join:ip:${ipOf(req)}`, ABUSE.joinPerIp, "Too many sign-in tries. Wait a bit and try again.");
    const them = await claimFor(env, b.token);
    if (them.managed_by) {
      // Handing the list over: they pick their PIN here.
      const pin = pinValue(b.pin);
      if (!pin) fail(428, "Pick a 4-digit PIN so only you can sign in as you.");
      const done = await env.DB.prepare("UPDATE members SET managed_by = NULL, claim_expires = NULL, onboarded_at = NULL, pin_hash = ? WHERE id = ? AND managed_by IS NOT NULL")
        .bind(await hashPin(env, them.id, pin), them.id).run();
      if (!done.meta?.changes) fail(409, `${them.name} just signed in. Open the link again.`);
      return { token: await signIn(env, them.id), name: them.name, returning: false };
    }
    if (them.pin_hash) await checkPin(env, req, them, b.pin, b.turnstile);
    else await setFirstPin(env, req, them, b.pin);
    return { token: await signIn(env, them.id), name: them.name, returning: true };
  },

  // Make a passkey (step 1): options for navigator.credentials.create(). { options, id }
  async "POST passkey/new"(req, env) {
    const me = await auth(req, env);
    const rp = rpOf(env, req);
    const mine = await env.DB.prepare("SELECT id, transports FROM passkeys WHERE member_id = ?").bind(me.id).all();
    if (mine.results.length >= ABUSE.passkeysPerMember) fail(409, `You have ${mine.results.length} passkeys, the most allowed. Remove one first.`);
    const options = await generateRegistrationOptions({
      rpName: "Hints", rpID: rp.id,
      userName: me.lastName ? `${me.name} ${me.lastName}` : me.name, userID: new TextEncoder().encode(me.id),
      attestationType: "none",
      excludeCredentials: mine.results.map((r) => ({ id: r.id, transports: JSON.parse(r.transports || "[]") })),
      // Discoverable, so signing in needs no name or code: the phone offers the passkey for this site.
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    return { options, id: await newChallenge(env, options.challenge, me.id) };
  },
  // Make a passkey (step 2): checks what the phone made and keeps its public key. { id, response } -> { passkeys }
  async "POST passkey/save"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const rp = rpOf(env, req);
    const expectedChallenge = await takeChallenge(env, b.id, me.id);
    let v;
    try {
      v = await verifyRegistrationResponse({ response: b.response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: false });
    } catch (err) {
      console.log("passkey save", err?.message);
      fail(400, "That passkey didn't save. Try again.");
    }
    if (!v.verified || !v.registrationInfo) fail(400, "That passkey didn't save. Try again.");
    const c = v.registrationInfo.credential;
    await env.DB.prepare("INSERT OR IGNORE INTO passkeys (id, member_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(c.id, me.id, b64u.from(c.publicKey), c.counter || 0, JSON.stringify(c.transports || []), passkeyLabel(req), now()).run();
    return { passkeys: await passkeysOf(env, me.id) };
  },
  async "POST passkey/remove"(req, env) {
    const me = await auth(req, env);
    const { id } = await body(req);
    await env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND member_id = ?").bind(String(id || ""), me.id).run();
    return { passkeys: await passkeysOf(env, me.id) };
  },
  // Sign in with a passkey (step 1, signed out): options for navigator.credentials.get(). { options, id }
  async "POST passkey/start"(req, env) {
    await rateLimit(env, `passkey:ip:${ipOf(req)}`, ABUSE.passkeyPerIp, "Too many tries. Wait a bit and try again.");
    const options = await generateAuthenticationOptions({ rpID: rpOf(env, req).id, userVerification: "preferred" });
    return { options, id: await newChallenge(env, options.challenge) };
  },
  // Sign in with a passkey (step 2): { id, response } -> { token, name }
  async "POST passkey/signin"(req, env) {
    await rateLimit(env, `join:ip:${ipOf(req)}`, ABUSE.joinPerIp, "Too many sign-in tries. Wait a bit and try again.");
    const b = await body(req);
    const rp = rpOf(env, req);
    const expectedChallenge = await takeChallenge(env, b.id);
    const credId = String(b.response?.id || "");
    const pk = credId && (await env.DB.prepare("SELECT p.*, m.name FROM passkeys p JOIN members m ON m.id = p.member_id WHERE p.id = ?").bind(credId).first());
    if (!pk) fail(404, "That passkey isn't on Hints anymore. Sign in with your link or invite code instead.");
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: b.response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: false,
        credential: { id: pk.id, publicKey: b64u.to(pk.public_key), counter: pk.counter, transports: JSON.parse(pk.transports || "[]") },
      });
    } catch (err) {
      console.log("passkey signin", err?.message);
      fail(403, "That passkey didn't work. Try again.");
    }
    if (!v.verified) fail(403, "That passkey didn't work. Try again.");
    await env.DB.prepare("UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?").bind(v.authenticationInfo.newCounter || 0, now(), pk.id).run();
    return { token: await signIn(env, pk.member_id), name: pk.name };
  },

  // Your own sign-in link, for a new phone or computer. on: true makes a new one (the old one stops working),
  // false turns it off. Returns { token } (null when off). Only a hash is kept, so it can't be shown again.
  async "POST me/link"(req, env) {
    const me = await auth(req, env);
    const { on } = await body(req);
    await rateLimit(env, `invite:m:${me.id}`, ABUSE.invitesPerMemberDay, "That's a lot of new links today. Try again tomorrow.");
    const token = on ? newLinkToken() : null;
    await env.DB.prepare("UPDATE members SET claim_hash = ?, claim_expires = NULL WHERE id = ?").bind(token ? await sha256(token) : null, me.id).run();
    return { token };
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
    // People who use Hints (other than you) are asked first; everyone else goes straight in.
    const ask = [], direct = [];
    for (const id of ids) (id !== me.id && (await usesApp(env, id)) ? ask : direct).push(id);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)").bind(hh, name, t),
      env.DB.prepare("INSERT INTO group_households (group_id, household_id, added_at) VALUES (?, ?, ?)").bind(groupId, hh, t),
      ...direct.flatMap((id) => [env.DB.prepare("UPDATE members SET household_id = ? WHERE id = ?").bind(hh, id), petsInto(env, id, hh)]),
    ]);
    for (const id of direct) await budgetsOnJoin(env, id, hh);
    for (const id of ask) await askToJoinHousehold(env, me, id, hh);
    return { household: { id: hh }, asked: ask.length };
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
    const them = await env.DB.prepare("SELECT name, household_id, managed_by FROM members WHERE id = ?").bind(memberId).first();
    if (!them) fail(404, "Person not found.");
    const myHh = await householdOf(env, me.id);
    let hh = b.householdId ? await manageableHousehold(env, me.id, b.householdId) : myHh;
    if (them.household_id && them.household_id === hh) fail(409, `${them.name} is already in this household.`);
    if (them.household_id) fail(409, `${them.name} is already in another household. Take them out of it first.`);
    if (!hh && memberId === me.id) fail(400, "Pick someone to add.");
    if (memberId === me.id && hh !== myHh) {
      // Moving yourself into someone else's household would show you their shopping: they add you instead.
      const others = await env.DB.prepare("SELECT 1 FROM members WHERE household_id = ? AND managed_by IS NULL LIMIT 1").bind(hh).first();
      if (others) fail(403, "Ask someone in that household to add you.");
    }
    // Someone who uses Hints says yes first (they'd share budgets and purchases with this household).
    if (memberId !== me.id && !them.managed_by) {
      const asked = await askToJoinHousehold(env, me, memberId, hh || null);
      return { ok: true, asked: true, again: !asked };
    }
    if (!hh) {
      hh = newId();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO households (id, name, created_at) VALUES (?, NULL, ?)").bind(hh, now()),
        env.DB.prepare("UPDATE members SET household_id = ? WHERE id = ?").bind(hh, me.id),
        petsInto(env, me.id, hh),
      ]);
    }
    await joinHousehold(env, memberId, hh);
    return { ok: true };
  },

  // Answer a request to join a household: { id, accept }. Yes puts you in it (or starts it with whoever asked).
  async "POST household/answer"(req, env) {
    const me = await auth(req, env);
    const { id, accept } = await body(req);
    const r = await env.DB.prepare("SELECT * FROM household_requests WHERE id = ? AND member_id = ?").bind(String(id || ""), me.id).first();
    if (!r) fail(404, "That request is gone. They may have taken it back.");
    if (!accept) {
      await env.DB.prepare("DELETE FROM household_requests WHERE id = ?").bind(r.id).run();
      await dropIfEmpty(env, r.household_id);
      return { ok: true };
    }
    if (await householdOf(env, me.id)) fail(409, "You're already in a household. Leave it first (Settings > Household).");
    const inviter = await env.DB.prepare("SELECT id, name, household_id FROM members WHERE id = ?").bind(r.invited_by).first();
    let hh = r.household_id;
    if (hh && !(await env.DB.prepare("SELECT 1 FROM households WHERE id = ?").bind(hh).first())) hh = null;
    if (!hh) {
      // "Start a household with me": theirs if they've made one since, else a new one with them in it.
      if (!inviter || !(await sharesGroup(env, me.id, inviter.id))) {
        await env.DB.prepare("DELETE FROM household_requests WHERE id = ?").bind(r.id).run();
        fail(404, "That request is gone. They may have taken it back.");
      }
      hh = inviter.household_id;
      if (!hh) {
        hh = newId();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO households (id, name, created_at) VALUES (?, NULL, ?)").bind(hh, now()),
          env.DB.prepare("UPDATE members SET household_id = ? WHERE id = ?").bind(hh, inviter.id),
          petsInto(env, inviter.id, hh),
        ]);
      }
    }
    const kept = await joinHousehold(env, me.id, hh);
    // Tell the people already in it (the sharing sheet in the app explains the rest).
    const { results: mates } = await env.DB.prepare("SELECT id FROM members WHERE household_id = ? AND id != ? AND managed_by IS NULL").bind(hh, me.id).all();
    for (const m of mates) {
      const nick = (await env.DB.prepare("SELECT nickname FROM nicknames WHERE author_id = ? AND subject_id = ?").bind(m.id, me.id).first())?.nickname;
      await pushTo(env, m.id, { title: `${nick || me.name} joined your household`, body: "You'll plan gifts together for everyone outside it.", url: "/#budget", tag: `hhjoin:${me.id}` })
        .catch((err) => console.error("household join push", err));
    }
    // Your budgets for people outside it moved in, except where the household already had one: say which.
    const keptFor = [];
    for (const k of kept) {
      const [kind, id] = [k.target.slice(0, 2), k.target.slice(2)];
      if (kind === "m:") keptFor.push((await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(id).first())?.name);
      else {
        const h = await env.DB.prepare("SELECT name FROM households WHERE id = ?").bind(id).first();
        const { results } = await env.DB.prepare("SELECT name FROM members WHERE household_id = ? ORDER BY name COLLATE NOCASE").bind(id).all();
        keptFor.push(householdLabel(h?.name, results.map((r) => r.name)));
      }
    }
    return { ok: true, household: { id: hh }, kept: [...new Set(keptFor.filter(Boolean))] };
  },

  // Take back a request to join a household: whoever asked, anyone in that household, or a circle admin who
  // can manage it. { id }
  async "POST household/uninvite"(req, env) {
    const me = await auth(req, env);
    const { id } = await body(req);
    const r = await env.DB.prepare("SELECT * FROM household_requests WHERE id = ?").bind(String(id || "")).first();
    if (!r) return { ok: true };
    if (r.invited_by !== me.id) {
      if (!r.household_id) fail(404, "Request not found.");
      await manageableHousehold(env, me.id, r.household_id);
    }
    await env.DB.prepare("DELETE FROM household_requests WHERE id = ?").bind(r.id).run();
    await dropIfEmpty(env, r.household_id);
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

  // ---------- pets ----------
  // Add or change a pet. New: { householdId? | as?, name, kind, notes? } (your household by default, or yours if you
  // aren't in one; as: someone you look after). Existing: { id, name?, kind?, notes? }. photo: data URL, "" removes, absent keeps.
  async "POST pet/save"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const kind = b.kind === undefined ? undefined : PET_KINDS.has(b.kind) ? b.kind : fail(400, "Pick what kind of pet.");
    const name = b.name === undefined ? undefined : text(b.name, LIMITS.petName, "Name", true);
    const notes = b.notes === undefined ? undefined : text(b.notes, LIMITS.petNotes, "Notes");
    const photo = b.photo === undefined ? undefined : photoValue(b.photo);
    const t = now();
    if (b.id) {
      const pet = await env.DB.prepare("SELECT * FROM pets WHERE id = ?").bind(String(b.id)).first();
      if (!pet) fail(404, "Pet not found.");
      if (pet.household_id) await manageableHousehold(env, me.id, pet.household_id);
      else await ownerFor(env, me, pet.member_id);
      await env.DB.prepare(
        `UPDATE pets SET name = ?, kind = ?, notes = ?, photo = ?, photo_at = ? WHERE id = ?`,
      ).bind(name ?? pet.name, kind ?? pet.kind, notes === undefined ? pet.notes : notes,
        photo === undefined ? pet.photo : photo, photo === undefined ? pet.photo_at : photo ? t : null, pet.id).run();
      return { pet: { id: pet.id } };
    }
    if (!name) fail(400, "Name is required.");
    const owner = await petOwner(env, me, b);
    const col = owner.household ? "household_id" : "member_id";
    const key = owner.household || owner.member;
    const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pets WHERE ${col} = ?`).bind(key).first();
    if (n >= PETS_MAX) fail(409, `That's ${PETS_MAX} pets already.`);
    const id = newId();
    await env.DB.prepare(
      `INSERT INTO pets (id, ${col}, name, kind, notes, photo, photo_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, key, name, kind || "other", notes ?? null, photo ?? null, photo ? t : null, t).run();
    return { pet: { id } };
  },

  async "POST pet/delete"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const pet = await env.DB.prepare("SELECT id, household_id, member_id FROM pets WHERE id = ?").bind(String(b.id || "")).first();
    if (!pet) fail(404, "Pet not found.");
    if (pet.household_id) await manageableHousehold(env, me.id, pet.household_id);
    else await ownerFor(env, me, pet.member_id);
    await env.DB.prepare("DELETE FROM pets WHERE id = ?").bind(pet.id).run();
    return { ok: true };
  },

  // Change your name, PIN, photo and/or profile. pin: "1234" sets it, "" removes it, absent leaves it alone.
  // photo: a small JPEG data URL (the app resizes it to a square first), "" removes it, absent leaves it alone.
  // cover: a wide JPEG data URL for the profile card's cover (the app crops it to 3:1), "" removes it, absent leaves it alone.
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
    const feedBefore = await feedProfileSnap(env, who);
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
      // Everyone keeps a PIN (it's what stops the circle link signing anyone in as you). It can be changed, not removed.
      if (!pin) fail(400, "Your PIN can be changed, but not turned off.");
      await env.DB.prepare("UPDATE members SET pin_hash = ?, pin_cleared_by = NULL, pin_cleared_at = NULL WHERE id = ?")
        .bind(pin ? await hashPin(env, who, pin) : null, who)
        .run();
    }
    if (b.photo !== undefined) {
      const photo = photoValue(b.photo);
      await env.DB.prepare("UPDATE members SET photo = ?, photo_at = ? WHERE id = ?").bind(photo, photo ? now() : null, who).run();
    }
    if (b.cover !== undefined) {
      const cover = coverValue(b.cover);
      await env.DB.prepare("UPDATE members SET cover = ?, cover_at = ? WHERE id = ?").bind(cover, cover ? now() : null, who).run();
    }
    await feedProfile(env, who, feedBefore, await feedProfileSnap(env, who));
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
  // ?m= a person, ?g= a circle, ?h= a household, ?p= a pet, ?c= a person's profile cover.
  async "GET photo"(req, env, url) {
    const q = url.searchParams;
    const [table, id, col] = q.has("g") ? ["groups", q.get("g"), "photo"] : q.has("h") ? ["households", q.get("h"), "photo"] : q.has("p") ? ["pets", q.get("p"), "photo"]
      : q.has("c") ? ["members", q.get("c"), "cover"] : ["members", q.get("m"), "photo"];
    const row = await env.DB.prepare(`SELECT ${col} AS photo FROM ${table} WHERE id = ?`).bind(id || "").first();
    const m = row?.photo && PHOTO_RE.exec(row.photo);
    if (!m) return new Response("Not found", { status: 404 });
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { "content-type": `image/${m[1]}`, "cache-control": "public, max-age=31536000, immutable" } });
  },

  // Make a new share link (on: true; the old one stops working) or turn it off. as: someone you look after.
  async "POST share/link"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const owner = await ownerFor(env, me, b.as);
    const token = b.on ? shareToken() : null;
    await env.DB.prepare("UPDATE members SET share_token = ? WHERE id = ?").bind(token, owner).run();
    return { token };
  },

  // The add key for the "Add to Hints" iPhone Shortcut (on: true makes a new one, the old one stops working;
  // false turns it off). Shown once; only its hash is kept.
  async "POST addkey"(req, env) {
    const me = await auth(req, env);
    const { on } = await body(req);
    if (on) await rateLimit(env, `addkey:m:${me.id}`, ABUSE.addKeysPerMemberDay, "That's a lot of new keys today. Try again tomorrow.");
    const key = on ? `hk_${newToken()}` : null;
    await env.DB.prepare("UPDATE members SET add_key_hash = ? WHERE id = ?").bind(key ? await sha256(key) : null, me.id).run();
    return { key };
  },

  // The iPhone Share button, through the "Add to Hints" Shortcut (iPhones don't let web apps into the Share menu;
  // Android uses share_target in the manifest instead). No device sign-in: the x-hints-key header (or "key" in the
  // body) is the person's add key. Body: { text } with the shared link, alone or inside text ("Check out X!
  // https://..."), or { url }. The link is filled in like the Fill button and saved to Maybe, so nobody sees it
  // until it's published. Answers with one plain sentence that the Shortcut shows as a notification.
  async "POST quickadd"(req, env) {
    const say = (msg, status = 200) => new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    try {
      return say(await quickAdd(req, env));
    } catch (err) {
      if (err instanceof HttpError) return say(err.message, err.status);
      console.error("quickadd", err);
      return say("Something went wrong. Try again.", 500);
    }
  },

  // ---------- problems and notes for whoever runs Hints (appOwner) ----------
  // The app reports its own errors here (uncaught errors and failed promises), signed in or not.
  async "POST report"(req, env) {
    await rateLimit(env, `report:ip:${ipOf(req)}`, ABUSE.reportsPerIp);
    if ((await hit(env, "report:all", 86400)) > ABUSE.reportsPerDay) return { ok: true };
    const b = await body(req, 12_000);
    if (!b.message) fail(400, "Nothing to report.");
    const token = req.headers.get("x-wishlist-token");
    const who = token ? await env.DB.prepare("SELECT member_id FROM devices WHERE token = ?").bind(String(token)).first() : null;
    const detail = [b.where && `Where: ${clip(b.where, 300)}`, reportContext(req, b), b.stack && `\n${clip(b.stack, 3000)}`].filter(Boolean).join("\n");
    await recordProblem(env, { where: "App", message: b.message, detail, memberId: who?.member_id || null });
    return { ok: true };
  },
  // Settings > Questions or problems: a note to whoever runs Hints, with a notification to them.
  async "POST note"(req, env) {
    const me = await auth(req, env);
    await rateLimit(env, `note:${me.id}`, ABUSE.notesPerMember, "That's a lot of notes for now. Try again later.");
    const b = await body(req);
    const msg = text(b.body, 2000, "Your note", true);
    const owner = await appOwner(env);
    if (!owner) fail(404, "There's nobody to send it to yet.");
    const id = newId(), t = now();
    await env.DB.prepare(
      "INSERT INTO reports (id, kind, member_id, body, detail, sig, count, created_at, last_at) VALUES (?, 'note', ?, ?, ?, ?, 1, ?, ?)",
    ).bind(id, me.id, msg, reportContext(req, b), `n:${id}`, t, t).run();
    if (owner.id !== me.id) {
      const name = (await nicknamesFor(env, owner.id)).get(me.id) || me.name;
      await pushTo(env, owner.id, { title: `${name} sent you a note`, body: "Tap to read it.", url: "/#settings/inbox", tag: "notes" })
        .catch((err) => console.error("note push", err));
    }
    return { ok: true, to: owner.name };
  },
  // Settings > Inbox (owner only): open notes and problems first, newest first.
  async "GET reports"(req, env) {
    const me = await auth(req, env);
    await ownerOnly(env, me);
    const { results } = await env.DB.prepare(
      "SELECT r.*, m.name FROM reports r LEFT JOIN members m ON m.id = r.member_id ORDER BY r.done_at IS NOT NULL, r.last_at DESC LIMIT 200",
    ).all();
    const nicks = await nicknamesFor(env, me.id);
    return {
      reports: results.map((r) => ({
        id: r.id, kind: r.kind, body: r.body, detail: r.detail || null, count: r.count, createdAt: r.created_at, lastAt: r.last_at,
        done: !!r.done_at, from: r.member_id ? { id: r.member_id, name: nicks.get(r.member_id) || r.name || "Someone who left" } : null,
      })),
    };
  },
  async "POST reports/done"(req, env) {
    const me = await auth(req, env);
    await ownerOnly(env, me);
    const b = await body(req);
    await env.DB.prepare("UPDATE reports SET done_at = ? WHERE id = ?").bind(b.done === false ? null : now(), String(b.id || "")).run();
    return { ok: true };
  },
  async "POST reports/delete"(req, env) {
    const me = await auth(req, env);
    await ownerOnly(env, me);
    const b = await body(req);
    await env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(String(b.id || "")).run();
    return { ok: true };
  },

  // Deletion requests by email from people who can't sign in (privacy page): whoever runs Hints finds the person
  // (Settings > Inbox) and deletes them the same way Delete my Hints does. Owner only.
  async "POST owner/find"(req, env) {
    const me = await auth(req, env);
    await ownerOnly(env, me);
    const q = String((await body(req)).q || "").trim().slice(0, 60);
    if (q.length < 2) fail(400, "Type at least 2 letters of their name.");
    const { results } = await env.DB.prepare(
      `SELECT m.id, m.name, m.last_name, m.created_at, m.managed_by,
         (SELECT COUNT(*) FROM items i WHERE i.owner_id = m.id AND i.removed_at IS NULL) AS wishes,
         (SELECT GROUP_CONCAT(g.name, ', ') FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.member_id = m.id) AS circles
         FROM members m WHERE (m.name || ' ' || COALESCE(m.last_name, '')) LIKE ? ORDER BY m.name COLLATE NOCASE LIMIT 20`,
    ).bind(`%${q.replace(/[%_]/g, "")}%`).all();
    return { people: results.map((r) => ({ id: r.id, name: r.last_name ? `${r.name} ${r.last_name}` : r.name, since: r.created_at, wishes: r.wishes, circles: r.circles || "", lookedAfter: !!r.managed_by })) };
  },
  async "POST owner/delete"(req, env) {
    const me = await auth(req, env);
    await ownerOnly(env, me);
    const { memberId } = await body(req);
    if (!memberId || memberId === me.id) fail(400, "To delete yourself, use Delete my Hints.");
    if (!(await env.DB.prepare("SELECT 1 FROM members WHERE id = ?").bind(String(memberId)).first())) fail(404, "That person isn't on Hints anymore.");
    await deleteMember(env, String(memberId));
    return { ok: true };
  },

  // ---------- keeping a circle closed ----------
  // A new invite link for a circle (the admin only). Old links and the old code stop working at once, so a
  // forwarded link or someone who was taken out can't use it to come back. Personal links keep working.
  async "POST family/code"(req, env) {
    const me = await auth(req, env);
    const { groupId } = await body(req);
    if (!(await myGroupIds(env, me.id)).includes(groupId)) fail(404, "Circle not found.");
    if ((await adminOf(env, groupId)) !== me.id) fail(403, "Only the circle's admin can reset its invite link.");
    await rateLimit(env, `code:m:${me.id}`, ABUSE.invitesPerMemberDay, "That's a lot of new links today. Try again tomorrow.");
    const code = await newUniqueJoinCode(env);
    await env.DB.prepare("UPDATE groups SET join_code = ? WHERE id = ?").bind(code, groupId).run();
    return { code };
  },

  // Let someone who asked to join in (allow: true), or turn them away. The admin only.
  async "POST family/request"(req, env) {
    const me = await auth(req, env);
    const { groupId, memberId, allow } = await body(req);
    if (!(await myGroupIds(env, me.id)).includes(groupId)) fail(404, "Circle not found.");
    if ((await adminOf(env, groupId)) !== me.id) fail(403, "Only the circle's admin can let people in.");
    const r = await env.DB.prepare("SELECT r.member_id, m.name, g.name AS group_name FROM join_requests r JOIN members m ON m.id = r.member_id JOIN groups g ON g.id = r.group_id WHERE r.group_id = ? AND r.member_id = ?")
      .bind(groupId, String(memberId || "")).first();
    if (!r) fail(404, "That request is gone. Someone may have answered it already.");
    if (allow) {
      const clash = await env.DB.prepare(
        `SELECT 1 FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = ? AND ${SAME_SLOT}`,
      ).bind(groupId, r.name, (await env.DB.prepare("SELECT last_name FROM members WHERE id = ?").bind(r.member_id).first())?.last_name || null, await householdOf(env, r.member_id)).first();
      if (clash) fail(409, `Someone named ${r.name} is already in ${r.group_name}. Ask them to add a last name, then let them in.`);
      await circleSlot(env, r.member_id);
      await circleRoom(env, groupId);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM join_requests WHERE group_id = ? AND member_id = ?").bind(groupId, r.member_id),
        env.DB.prepare(JOIN_DIRECT).bind(groupId, r.member_id, now()),
      ]);
      await pushTo(env, r.member_id, { title: `You're in ${r.group_name}!`, body: "Tap to see everyone's lists.", url: "/#family", tag: `joined:${groupId}` })
        .catch((err) => console.error("join push", err));
      return { ok: true };
    }
    await env.DB.prepare("DELETE FROM join_requests WHERE group_id = ? AND member_id = ?").bind(groupId, r.member_id).run();
    return { ok: true };
  },

  // Take back your own request to join (all of them without groupId). Your list stays, circle or not.
  async "POST join/cancel"(req, env) {
    const me = await auth(req, env);
    const { groupId } = await body(req);
    await env.DB.prepare(groupId ? "DELETE FROM join_requests WHERE member_id = ? AND group_id = ?" : "DELETE FROM join_requests WHERE member_id = ?")
      .bind(...(groupId ? [me.id, groupId] : [me.id])).run();
    return { ok: true };
  },

  // ---------- your account ----------
  // Sign out every other phone and computer (this one stays signed in), with their notifications.
  async "POST signout/others"(req, env) {
    const me = await auth(req, env);
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE member_id = ? AND token != ?").bind(me.id, me.token).first();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM push_subs WHERE member_id = ? AND (device_token IS NULL OR device_token != ?)").bind(me.id, me.token),
      env.DB.prepare("DELETE FROM devices WHERE member_id = ? AND token != ?").bind(me.id, me.token),
    ]);
    return { ok: true, signedOut: n };
  },

  // Delete my Hints: your profile, list, ideas, budgets, purchases, chat messages, photos and sign-ins, for good.
  // Asks for your PIN. The people you look after go to someone else who can (your household, else a circle admin).
  // A circle you're alone in goes with you; any other circle gets a new admin.
  async "POST account/delete"(req, env) {
    const me = await auth(req, env);
    const b = await body(req);
    const row = await env.DB.prepare("SELECT id, name, pin_hash FROM members WHERE id = ?").bind(me.id).first();
    if (row.pin_hash) await checkPin(env, req, row, b.pin, b.turnstile);
    await deleteMember(env, me.id);
    return { ok: true };
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
    // A scope per request: auth() records who it's for, so Gemini calls count against that person (src/limits.js).
    const out = await scope.run({ route: key }, () => handlers[key](request, env, new URL(request.url), ctx));
    return out instanceof Response ? out : json(out);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, ...(err.extra || {}) }, err.status);
    console.error("wishlist", key, err);
    // Shows up in Settings > Inbox for whoever runs Hints.
    const saved = recordProblem(env, { where: `API ${key}`, message: err?.message || String(err), detail: clip(err?.stack, 3000) || null })
      .catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(saved); else await saved;
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
