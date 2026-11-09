// Abuse limits: rate limits, daily quotas and hard caps, so nobody can flood the database, guess PINs or
// invite codes, or run up the Gemini bill. Every number is in LIMITS below, in one place, so they're easy to tune.
//
// Two layers:
//   1. BURST (wrangler.jsonc "ratelimits" binding): a cheap per-IP cap on every API call and invite page.
//      Counted by Cloudflare, no D1 writes. Approximate (each Cloudflare location counts on its own).
//   2. D1 counters (rate_limits table, migration 0024): exact counts for the things that matter: sign-ups,
//      PIN guesses, invite code lookups and anything that calls Gemini. Old rows are swept now and then.

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
  pricesPerMember: [[120, 3600]],
  refreshPerMember: [[120, 3600]],
  imagePerMember: [[400, 3600]],
  estimatePerMember: [[150, 3600], [600, 86400]], // "~$40" price guesses
  // Hidden chat about a person.
  chatSendsPerMember: [[60, 3600], [300, 86400]],
  // Notifications: devices per person (the oldest is dropped past this), test pushes, and group gift alerts started.
  pushSubsPerMember: 15,
  pushTestPerMember: [[10, 3600]],
  groupAlertsPerMemberDay: [10, 86400],
  // Whole app: Gemini calls per day (UTC). GEMINI_DAILY_CAP in wrangler.jsonc vars overrides it.
  geminiPerDay: 1500,
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

// Gemini calls today across the whole app. Counts this call and returns false once over the daily cap.
export async function geminiAllowed(env) {
  if (!env.DB) return true;
  const cap = Number(env.GEMINI_DAILY_CAP) || LIMITS.geminiPerDay;
  try {
    return (await hit(env, "gemini:all", 86400)) <= cap;
  } catch {
    return true; // never block on a counting hiccup
  }
}
