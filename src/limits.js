// Abuse limits: rate limits, daily quotas and hard caps, so nobody can flood the database, guess PINs or
// invite codes, or run up the Gemini bill. Every number is in LIMITS below, in one place, so they're easy to tune.
//
// Two layers:
//   1. BURST (wrangler.jsonc "ratelimits" binding): a cheap per-IP cap on every API call and invite page.
//      Counted by Cloudflare, no D1 writes. Approximate (each Cloudflare location counts on its own).
//   2. D1 counters (rate_limits table, migration 0024): exact counts for the things that matter: sign-ups,
//      PIN guesses, invite code lookups and anything that calls Gemini. Old rows are swept now and then.

import { AsyncLocalStorage } from "node:async_hooks";

export const LIMITS = {
  // Burst, per IP, every /api/ call and /join/ page (the binding's own limit lives in wrangler.jsonc).
  // Unauthenticated, per IP (IPv6 counts per /64, since one person usually has a whole /64).
  lookupPerIp: [40, 3600], // invite code lookups (also /join/CODE previews): [max, window seconds]
  joinPerIp: [30, 3600], // sign-in attempts
  newMemberPerIp: [8, 86400], // new people added by name
  startPerIp: [4, 86400], // new circles started from the welcome screen
  // Whole app, per day: a backstop if someone spreads sign-ups over many IPs.
  newMembersPerDay: 300,
  newCirclesPerDay: 100,
  // PIN tries (right or wrong), per person and per IP. 20 a day means guessing a 4-digit PIN takes over a year.
  pinTriesPerMember: [[8, 900], [20, 86400]],
  pinTriesPerIp: [30, 3600],
  // Hard caps on what one person or circle can hold.
  devicesPerMember: 15, // signed-in phones and browsers; the oldest is signed out past this
  itemsPerMember: 300, // wishes, Maybe included
  ideasPerMember: 500, // gift ideas you wrote, for everyone
  circlesPerMember: 20,
  membersPerCircle: 100,
  circlesStartedPerMemberDay: [5, 86400],
  managedPerMember: 40, // people you look after (kids, grandparents, or people you set up before they join)
  managedAddsPerMemberDay: [40, 86400],
  invitesPerMemberDay: [80, 86400], // personal invite links made
  // Per person, things that fetch store pages or call Gemini.
  previewPerMember: [[80, 3600], [300, 86400]],
  identifyPerMember: [[15, 3600], [40, 86400]],
  namePerMember: [[30, 3600], [100, 86400]], // the ✨ clean-up-the-name button
  recommendPerMember: [[10, 3600], [30, 86400]], // "Ideas for you" on My list
  pricesPerMember: [[120, 3600]],
  refreshPerMember: [[120, 3600]],
  imagePerMember: [[400, 3600]],
  estimatePerMember: [[150, 3600], [600, 86400]], // "~$40" price guesses
  quickAddPerMember: [[30, 3600], [100, 86400]], // links added from the iPhone Share button (Shortcut)
  addKeysPerMemberDay: [20, 86400], // new add keys made for that Shortcut
  // Hidden chat about a person.
  chatSendsPerMember: [[60, 3600], [300, 86400]],
  // Activity feed: posts, and comments (src/wishlist.js, docs/plans/activity-feed.md).
  feedPostsPerMember: [[20, 3600], [60, 86400]],
  feedCommentsPerMember: [[60, 3600], [300, 86400]],
  // Notifications: devices per person (the oldest is dropped past this), test pushes, and group gift alerts started.
  pushSubsPerMember: 15,
  pushTestPerMember: [[10, 3600]],
  groupAlertsPerMemberDay: [10, 86400],
  // Problems the app reports on its own (per IP, and a whole-app daily backstop) and notes to the owner.
  reportsPerIp: [[30, 3600], [100, 86400]],
  reportsPerDay: 1000,
  notesPerMember: [[10, 3600], [30, 86400]],
  // Whole app: Gemini requests per day (UTC), retries included. GEMINI_DAILY_CAP in wrangler.jsonc vars overrides it.
  geminiPerDay: 1500,
  // Of those, requests that use Google Search grounding (billed per search after 5,000 free a month). 150 a day
  // stays inside the free allowance. Past it, calls run without search. GEMINI_GROUNDED_CAP overrides it.
  geminiGroundedPerDay: 150,
  // Per person, per day, across every feature: [established, account under 7 days old].
  // "user" is what someone taps (Fill, ✨ name, photo search, the Share button); "auto" is what the app does on
  // its own while they use it (price guesses, missing photos and prices, details refresh).
  geminiUserPerMember: [60, 25],
  geminiAutoPerMember: [100, 40],
  // Share of the daily cap only established accounts and the hourly schedule can use, so a wave of new
  // sign-ups can't use up the day for everyone else.
  geminiReserve: 0.2,
  newAccountDays: 7,
  // Of the daily Google Search calls, how many are kept for things people tap: background price checks and
  // lookups stop using search once only this many are left.
  geminiGroundedForTaps: 50,
  // PIN guessing across the whole app: wrong PINs per hour before Hints tightens up for everyone (fewer tries,
  // Turnstile if it's set up) and tells whoever runs Hints.
  pinMissesPerHour: 60,
  // Tries per person while that's on (normally pinTriesPerMember).
  pinTriesLockdown: [[3, 3600]],
  // Wrong PINs for one person (15 minutes) before they get "Someone tried to sign in as you" and, with
  // Turnstile set up, before a check is asked for.
  pinMissesWarn: 3,
  // Passkey sign-in starts (unauthenticated, per IP).
  passkeyPerIp: [30, 3600],
  passkeysPerMember: 10,
  // Request bodies.
  maxBody: 400_000,
  maxPhotoBody: 6_000_000,
};

const nowSec = () => Math.floor(Date.now() / 1000);

// Counts one hit for `key` in the current window and returns the new count. Exact (one D1 row per key per window).
export async function hit(env, key, windowSec, by = 1) {
  const bucket = Math.floor(nowSec() / windowSec) * windowSec;
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, bucket, count) VALUES (?, ?, ?) ON CONFLICT (key, bucket) DO UPDATE SET count = count + excluded.count RETURNING count",
  ).bind(`${key}@${windowSec}`, bucket, by).first();
  // Sweep old windows about once every 200 hits. Nothing here lasts longer than a day.
  if (Math.random() < 0.005) {
    await env.DB.prepare("DELETE FROM rate_limits WHERE bucket < ?").bind(nowSec() - 2 * 86400).run().catch(() => {});
  }
  return row?.count ?? by;
}

// The current count for `key` in this window, without counting.
export async function peek(env, key, windowSec) {
  const bucket = Math.floor(nowSec() / windowSec) * windowSec;
  const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE key = ? AND bucket = ?").bind(`${key}@${windowSec}`, bucket).first();
  return row?.count ?? 0;
}

// The caller's IP. IPv6 is cut to its /64 (one home or phone usually gets a whole /64, so per-address limits are useless).
export function ipOf(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
  return `${full.slice(0, 4).join(":")}::/64`;
}

// Per-IP burst cap from the ratelimits binding. True when the call may go ahead. No binding (local dev, or the
// account doesn't offer it) means no burst cap; the D1 limits still apply.
export async function burstOk(env, request) {
  if (!env.BURST?.limit) return true;
  try {
    const { success } = await env.BURST.limit({ key: ipOf(request) });
    return success;
  } catch {
    return true;
  }
}

// Who an API request is for, so Gemini calls deep inside link lookups can be counted against the right person
// without passing them through every function. src/wishlist.js handle() opens a scope per request ({ route });
// auth() and the Share button add { member: { id, createdAt, trusted } }. The hourly schedule has no scope.
// Needs the "nodejs_als" compatibility flag (wrangler.jsonc).
export const scope = new AsyncLocalStorage();
// Routes where Gemini runs because someone tapped something (the rest are the app working on its own).
const GEMINI_USER_ROUTES = new Set(["POST preview", "POST name", "POST identify", "POST quickadd", "POST recommend"]);

export const isNewAccount = (createdAt) =>
  !createdAt || Date.now() - Date.parse(createdAt) < LIMITS.newAccountDays * 86_400_000;

// Whether a Gemini request may go ahead, before it's made. Checks, in order: the person's daily allowance, the
// reserve (new accounts stop at 80% of the day), and the whole-app cap. Trusted accounts (members.ai_trusted:
// everyone who was on Hints before public sign-ups, plus anyone the owner raises) skip the first two: only the
// whole-app cap applies to them. grounded: whether Google Search may be used. It stops at the grounded cap, and
// for background work (anything not tapped, including the hourly schedule) it stops geminiGroundedForTaps
// earlier, so taps always have some left. Fails closed: Gemini is optional, so a counting error means no.
// { ok, grounded, why: "person" | "busy" | "app" | "error" }
export async function geminiAllowed(env, { grounded = false } = {}) {
  if (!env.DB) return { ok: true, grounded };
  const cap = Number(env.GEMINI_DAILY_CAP) || LIMITS.geminiPerDay;
  const groundedCap = Number(env.GEMINI_GROUNDED_CAP) || LIMITS.geminiGroundedPerDay;
  try {
    const s = scope.getStore();
    const user = GEMINI_USER_ROUTES.has(s?.route);
    const used = await peek(env, "gemini:all", 86400);
    if (s?.member && !s.member.trusted) {
      const fresh = isNewAccount(s.member.createdAt);
      const [norm, newb] = user ? LIMITS.geminiUserPerMember : LIMITS.geminiAutoPerMember;
      if ((await peek(env, `gemini:${user ? "u" : "a"}:${s.member.id}`, 86400)) >= (fresh ? newb : norm)) return { ok: false, why: "person" };
      if (fresh && used >= cap * (1 - LIMITS.geminiReserve)) return { ok: false, why: "busy" };
    }
    if (used >= cap) return { ok: false, why: "app" };
    if (!grounded) return { ok: true, grounded: false };
    const searchLimit = user ? groundedCap : Math.max(0, groundedCap - LIMITS.geminiGroundedForTaps);
    return { ok: true, grounded: (await peek(env, "gemini:grounded", 86400)) < searchLimit };
  } catch (err) {
    console.error("gemini allowance", err);
    return { ok: false, why: "error" };
  }
}

// Counts one Gemini request (call it for every request sent, retries included).
export async function geminiCount(env, grounded) {
  if (!env.DB) return;
  const s = scope.getStore();
  const keys = ["gemini:all"];
  if (grounded) keys.push("gemini:grounded");
  if (s?.member) keys.push(`gemini:${GEMINI_USER_ROUTES.has(s.route) ? "u" : "a"}:${s.member.id}`);
  await Promise.all(keys.map((k) => hit(env, k, 86400))).catch((err) => console.error("gemini count", err));
}
