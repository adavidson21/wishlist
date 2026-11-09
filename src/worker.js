// hints.alexisdavidson.org. The Worker runs before static files (run_worker_first in wrangler.jsonc) so the
// retired wishlist.alexisdavidson.org can redirect everything here. API calls go to src/wishlist.js, invite links (/join/CODE) get the app page
// with a link preview for that circle, everything else is a static file.
// Every response gets the security headers below and an x-app-version header (the deploy id). API calls and invite pages also pass a per-IP burst cap (src/limits.js).
import { routes, inviteInfo, runSchedule, sharePage } from "./wishlist.js";
import { json } from "./gemini.js";
import { LIMITS, burstOk, hit, ipOf } from "./limits.js";

const HOST = "hints.alexisdavidson.org";
const OLD_HOST = "wishlist.alexisdavidson.org"; // retired November 2026 (the app was called Wishlist)

// Safe for the whole app: no framing (clickjacking), no MIME sniffing, HTTPS only, minimal referrers,
// and no access to the mic, location or payment APIs. (No CSP yet: the page uses inline scripts and styles.)
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "geolocation=(), microphone=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
};

function secure(res) {
  const out = new Response(res.body, res); // copies status and headers into a mutable response
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

const tooMany = () => {
  const res = json({ error: "Too many requests. Wait a minute and try again." }, 429);
  res.headers.set("retry-after", "60");
  return res;
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname === OLD_HOST) {
      url.protocol = "https:";
      url.hostname = HOST;
      return Response.redirect(url.toString(), 301);
    }
    const res = secure(await route(request, env, url, ctx));
    // Which deploy answered. The app compares it across API calls and offers a refresh when it changes.
    const version = env.CF_VERSION_METADATA?.id;
    if (version) res.headers.set("x-app-version", version);
    return res;
  },
  // Hourly Cron Trigger (wrangler.jsonc): notifications (new-wish digest, and reminders at 9am New York).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  },
};

async function route(request, env, url, ctx) {
  const isApi = url.pathname.startsWith("/api/");
  const join = url.pathname.match(/^\/join\/([A-Za-z0-9]{3,12})\/?$/);
  // A read-only list shared outside the circle (src/wishlist.js sharePage).
  const share = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,64})\/?$/);
  if ((isApi || join || share) && !(await burstOk(env, request))) {
    return isApi ? tooMany() : new Response("Too many requests. Wait a minute and try again.", { status: 429, headers: { "retry-after": "60" } });
  }
  const handler = routes[url.pathname];
  if (handler) return handler(request, env, ctx);
  if (isApi) return json({ error: "Not found." }, 404);
  if (join && (request.method === "GET" || request.method === "HEAD")) return invitePage(request, env, url, join[1]);
  if (share && (request.method === "GET" || request.method === "HEAD")) return sharePage(env, share[1], url);
  return env.ASSETS.fetch(request);
}

// The same single page as "/", with the title and Open Graph tags swapped so a pasted invite link
// shows "Join The Davidsons on Hints" in iMessage, WhatsApp, Facebook and so on.
// The page itself reads the code from the path.
async function invitePage(request, env, url, code) {
  // No conditional headers, so this is always a full 200 page and never a 304 to rewrite.
  const page = await env.ASSETS.fetch(new Request(new URL("/", url)));
  let info = null;
  try {
    // The preview says whether a code is real, so it shares the lookup limit: guessing codes here is no
    // easier than through /api/lookup. Over the limit, the page just shows the generic preview.
    const [max, win] = LIMITS.lookupPerIp;
    if (env.DB && (await hit(env, `lookup:ip:${ipOf(request)}`, win)) <= max) info = await inviteInfo(env, code, url.searchParams.get("from"));
  } catch (err) {
    console.error("invite preview", err);
  }
  const title = info ? `Join ${info.group.name} on Hints` : "You're invited to Hints";
  const description = info
    ? `${info.inviter ? `${info.inviter} invited you` : "You're invited"} to share wish lists with ${info.group.name}. Add what you'd love, see what everyone's hoping for, and keep gifts a surprise.`
    : "Wish lists for your circle: share what you'd like, mark what you're getting, keep gifts a surprise.";
  const setContent = (value) => ({ element: (el) => el.setAttribute("content", value) });
  const out = new HTMLRewriter()
    .on("title", { element: (el) => el.setInnerContent(title) })
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[name="twitter:description"]', setContent(description))
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:url"]', setContent(`https://${url.host}${url.pathname}${url.search}`))
    .transform(page);
  const res = new Response(out.body, out);
  res.headers.set("cache-control", "no-store");
  return res;
}
