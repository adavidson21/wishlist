// wishlist.alexisdavidson.org: static files in public/ are served first (see wrangler.jsonc);
// anything else comes here. API calls go to src/wishlist.js, everything else is a static file.
import { routes } from "./wishlist.js";
import { json } from "./gemini.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const handler = routes[pathname];
    if (handler) return handler(request, env);
    if (pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
    return env.ASSETS.fetch(request);
  },
};
