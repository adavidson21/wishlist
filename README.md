# Wishlist

Family wish lists at **wishlist.alexisdavidson.org**. Mark what you're getting someone (hidden from the list owner) and keep private gift notes per person. Installable on phones as a PWA.

One Cloudflare Worker with a D1 database. No build step.

## Layout

```
wrangler.jsonc        Cloudflare config: Worker, custom domain, D1 binding
src/worker.js         Router: /api/* to wishlist.js, everything else from public/
src/wishlist.js       API and privacy rules (D1)
src/gemini.js         Gemini call used by photo search
src/stores.js         Stores photo search may link to, plus blocked marketplaces
migrations/           D1 schema (wrangler d1 migrations)
public/index.html     The app (single page)
public/sw.js          Service worker (network first, offline fallback)
public/manifest.webmanifest, icons/, fonts/ (Figtree, Fraunces, OFL)
public/theme.js       Applies the saved light/dark choice (picked in Settings)
public/xlsx.js        Builds the Budget tab's Excel export in the browser
```

## Deploy

**First time**
1. `npm install`
2. `npx wrangler login`
3. `npx wrangler secret put GEMINI_API_KEY` (photo search; key from https://aistudio.google.com/apikey)
4. `npm run migrate` (applies any migrations not yet applied to the `wishlist` D1 database)
5. `npm run deploy`. The custom domain in `wrangler.jsonc` attaches itself.

**After that:** connect the repo in Cloudflare (Workers > wishlist > Settings > Build, root directory `/`) to deploy on every push to `main`, or run `npm run migrate && npm run deploy` by hand.
- Deploy command: `npm run migrate && npm run deploy`, so new migrations are applied before the new code goes live and merging is all it takes.
- Build token: needs Account > D1 > Write (Edit) for the migrate step. The token Workers Builds makes by default doesn't have it.

**Local:** copy `.dev.vars.example` to `.dev.vars`, then `npx wrangler d1 migrations apply wishlist --local` and `npm run dev`.

**Checks:** GitHub Actions runs `npm run check` (a `wrangler deploy --dry-run`) on every push and PR.

## How it works

- **Sign-in** is the honor system: a family code, then pick your name (or add yourself). A 4-digit PIN is optional and protects your private notes. Each device keeps a token in localStorage.
- **Privacy rules** live in `src/wishlist.js`: the list owner never gets purchased marks, private ideas only go to their author, and you only see lists of people in a family you share.
- **Seasons:** purchased marks are per calendar year (New York time), so they reset each Christmas while wishes carry over. Removing an item someone already bought keeps it for the buyer, flagged "removed".
- **Share link:** `/?code=ABC234` prefills the family code (the Family tab's Share button sends it).
- **Ideas and suggestions:** an idea about someone is private to its author. "Share as a suggestion" shows it to everyone in the family except the person it's for, who never gets it from the API.
- **Autofill:** pasting a link calls `/api/preview`, which reads the product name and price from JSON-LD, Open Graph tags, or Amazon's markup. Stores that block bots fall back to a name guessed from the URL.
- **Photo search:** `/api/identify` sends a shrunk photo to Gemini (`GEMINI_MODEL` in `wrangler.jsonc`) with Google Search turned on, for up to 4 matches. Each match gets a store link: the brand's own site first, then retailers in `src/stores.js`, then Amazon. Amazon ranks with the retailers only when the page shows it is shipped and sold by Amazon. Every link is opened to confirm it is a real product page (or, if the store blocks bots, that Google Search really returned it). Marketplaces and resellers are never linked. With no confirmed page, the link searches the likeliest store instead. Search grounding is billed per search after 5,000 free a month. Photos are not stored.
- **Photos:** pasting a link saves the store's product photo with the item (`image_url`, hotlinked, never copied). Items saved before that, or whose link changed, get their photo looked up once in the background (`POST /api/image`). With no photo, the tile shows a small drawing picked from the item's name (perfume bottle, book, sweater, headphones, gift box, and so on). Columns added in `migrations/0005_item_images.sql`.
- **Nicknames:** on someone's list, Rename lets you call them what you call them ("Grandma" instead of "Jane Doe"). Only you see it: the API swaps names for the viewer's nicknames everywhere (family, lists, "is getting this", budget, Excel), and the real name still shows in small text. Table `nicknames` (`migrations/0003_nicknames.sql`).
- **Budget:** your private budget per person, what you're getting them, and your open ideas, per season. "Add a purchase" records a gift that isn't on anyone's list (saved as an idea marked bought). "Download as Excel" builds the .xlsx in the browser. The URL hash is `#budget` (the old `#notes` still works).
- **More than one family:** in Settings, join another family by code, start a new one, invite, or leave one (not your last). You stay one person with one list. Each wish has a "Who can see this" switch per family; a wish hidden from a family is never shown through that family (`item_hidden`, migration 0004), though anyone who shares another family with you where it isn't hidden still sees it. The Family tab shows a section per family. Joining is blocked if that family already has someone with your name. Opening an invite link while signed in opens Settings with the code filled in.
- **Tabs:** My list, Family, a raised center Add a wish button (adds to your list from any screen), Budget, Settings.
- **Settings:** text size (Default, Large, Extra large) and appearance (Automatic, Light, Dark) are saved on the device.
- **Look and motion:** cream background, a wine header band, burgundy actions, gold for top picks, pine for "you're getting this". Fraunces for titles and big numbers, Figtree for everything else. Animations mark real moments (adding a wish, starring a top pick, "I'll get this" confetti, budget numbers counting) and all turn off with the device's Reduce Motion setting.

## Schema changes

Add a new numbered file in `migrations/`. The deploy command applies it on merge (or run `npm run migrate` by hand before deploying). The new code must not go live before its migration.

## History

Moved out of [personal-tools](https://github.com/adavidson21/personal-tools) (was `tools.alexisdavidson.org/wishlist/`) in November 2026. It uses the same D1 database, so anything created there is still here.
