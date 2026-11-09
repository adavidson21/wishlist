// hints.alexisdavidson.org (and the old wishlist.alexisdavidson.org): static files in public/ are served first (see wrangler.jsonc);
// anything else comes here. API calls go to src/wishlist.js, invite links (/join/CODE) get the app page
// with a link preview for that circle, everything else is a static file.
import { routes, inviteInfo } from "./wishlist.js";
import { json } from "./gemini.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const handler = routes[url.pathname];
    if (handler) return handler(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
    const join = url.pathname.match(/^\/join\/([A-Za-z0-9]{3,12})\/?$/);
    if (join && (request.method === "GET" || request.method === "HEAD")) return invitePage(env, url, join[1]);
    return env.ASSETS.fetch(request);
  },
};

// The same single page as "/", with the title and Open Graph tags swapped so a pasted invite link
// shows "Join The Davidsons on Hints" in iMessage, WhatsApp, Facebook and so on.
// The page itself reads the code from the path.
async function invitePage(env, url, code) {
  // No conditional headers, so this is always a full 200 page and never a 304 to rewrite.
  const page = await env.ASSETS.fetch(new Request(new URL("/", url)));
  let info = null;
  try {
    info = await inviteInfo(env, code, url.searchParams.get("from"));
  } catch (err) {
    console.error("invite preview", err);
  }
  const title = info ? `Join ${info.group.name} on Hints` : "You're invited to Hints";
  const description = info
    ? `${info.inviter ? `${info.inviter} invited you` : "You're invited"} to share wish lists with ${info.group.name}. Add what you'd love, see what everyone's hoping for, and keep gifts a surprise.`
    : "Wish lists for family and friends: share what you'd like, mark what you're getting, keep gifts a surprise.";
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
