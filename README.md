# Wishlist

Family wish lists at **wishlist.alexisdavidson.org**. Mark what you bought (hidden from the list owner) and keep private gift notes per person. Installable on phones as a PWA.

One Cloudflare Worker with a D1 database. No build step.

## Layout

```
wrangler.jsonc        Cloudflare config: Worker, custom domain, D1 binding
src/worker.js         Router: /api/* to wishlist.js, everything else from public/
src/wishlist.js       API and privacy rules (D1)
src/gemini.js         Gemini call used by photo search
migrations/           D1 schema (wrangler d1 migrations)
public/index.html     The app (single page)
public/sw.js          Service worker (network first, offline fallback)
public/manifest.webmanifest, icons/, fonts/ (Figtree, Gelasio, OFL)
public/theme.js       Light/dark toggle
public/xlsx.js        Builds the Tracker's Excel export in the browser
```

## Deploy

**First time**
1. `npm install`
2. `npx wrangler login`
3. `npx wrangler secret put GEMINI_API_KEY` (photo search; key from https://aistudio.google.com/apikey)
4. `npm run migrate` (applies any migrations not yet applied to the `wishlist` D1 database)
5. `npm run deploy`. The custom domain in `wrangler.jsonc` attaches itself.

**After that:** connect the repo in Cloudflare (Workers > wishlist > Settings > Build, root directory `/`, deploy command `npx wrangler deploy`) to deploy on every push to `main`, or run `npm run deploy` by hand.

**Local:** copy `.dev.vars.example` to `.dev.vars`, then `npx wrangler d1 migrations apply wishlist --local` and `npm run dev`.

**Checks:** GitHub Actions runs `npm run check` (a `wrangler deploy --dry-run`) on every push and PR.

## How it works

- **Sign-in** is the honor system: a family code, then pick your name (or add yourself). A 4-digit PIN is optional and protects your private notes. Each device keeps a token in localStorage.
- **Privacy rules** live in `src/wishlist.js`: the list owner never gets purchased marks, private ideas only go to their author, and you only see lists of people in your family.
- **Seasons:** purchased marks are per calendar year (New York time), so they reset each Christmas while wishes carry over. Removing an item someone already bought keeps it for the buyer, flagged "removed".
- **Share link:** `/?code=ABC234` prefills the family code (the Family tab's Share button sends it).
- **Ideas and suggestions:** an idea about someone is private to its author. "Share as a suggestion" shows it to everyone in the family except the person it's for, who never gets it from the API.
- **Autofill:** pasting a link calls `/api/preview`, which reads the product name and price from JSON-LD, Open Graph tags, or Amazon's markup. Stores that block bots fall back to a name guessed from the URL.
- **Photo search:** `/api/identify` sends a shrunk photo to Gemini (`GEMINI_MODEL` in `wrangler.jsonc`) for up to 4 matches. Photos are not stored.
- **Tracker:** your private budget per person, what you bought, and your open ideas, per season. "Export to Excel" builds the .xlsx in the browser.

## Schema changes

Add a new numbered file in `migrations/`, then `npm run migrate` after merging.

## History

Moved out of [personal-tools](https://github.com/adavidson21/personal-tools) (was `tools.alexisdavidson.org/wishlist/`) in November 2026. It uses the same D1 database, so anything created there is still here.
