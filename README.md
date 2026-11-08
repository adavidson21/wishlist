# Wishlist

Family wish lists at **wishlist.alexisdavidson.org**. Mark what you're getting someone (hidden from the list owner) and keep private gift notes per person. Installable on phones as a PWA.

One Cloudflare Worker with a D1 database. No build step.

## Layout

```
wrangler.jsonc        Cloudflare config: Worker, custom domain, D1 binding
src/worker.js         Router: /api/* to wishlist.js, /join/CODE invite pages (with link previews), everything else from public/
src/wishlist.js       API and privacy rules (D1)
src/gemini.js         Gemini call used by photo search
src/stores.js         Stores photo search may link to, plus blocked marketplaces
migrations/           D1 schema (wrangler d1 migrations)
public/index.html     The app (single page)
public/sw.js          Service worker (network first, offline fallback)
public/manifest.webmanifest, icons/, fonts/ (Figtree, Fraunces, OFL)
public/theme.js       Applies the saved light/dark choice (picked in Settings)
public/xlsx.js        Builds the Budget tab's Excel export in the browser
public/qr.js          Makes the invite QR code (SVG), loaded only when someone taps "Show QR code"
public/og-invite.png  Link preview image for invite links
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
- **Occasions:** purchased marks and budgets belong to an occasion: Christmas for everyone, plus each person's birthday (from their profile). The `season` columns hold the occasion's date as YYYYMMDD and count through that day in New York, then reset; wishes carry over (migration 0011). "I'll get this" asks which one it's for (soonest by default) when the person has a birthday, so a Christmas gift bought before a November birthday stays marked. Changing your birthday moves what family planned for the old date to the new one. Birth year is optional and shows as "turning 40". The Family tab shows "Birthday in 12 days" in the month before. Removing an item someone already bought keeps it for the buyer, flagged "removed".
- **Invite links:** `/join/ABC234?from=memberId`. The Worker serves the app page with the title and Open Graph tags swapped ("Join The Davidsons on Wishlist", "Alexis invited you...") so pasted links show a nice preview card. The page opens on an invite screen: an envelope opens, the family's avatars pop in, and one Join button leads to "Are you new here?" (new people first, returning people tap their name). A bad code gets a friendly "That invite didn't work" screen with a code box. Old `/?code=ABC234` links still work. Opening an invite while signed in asks "Join The Davidsons?" in a sheet (or does nothing if you're already in it).
- **Invite card:** the Family tab (and Invite buttons in Settings and per family) shows a ticket with the code, Copy invite (warm message, link, and code), Send (the phone's share sheet), and Show QR code for inviting someone in person.
- **Welcome tour:** after joining, a full-screen set of swipeable cards, each with a small animation: welcome, adding wishes, surprises stay hidden, private notes and budgets, an optional PIN, adding to the home screen, and (for someone who started a family) inviting the family. Shown once per person (`members.onboarded_at`, migration 0007; people from before it count as done). Settings has "Replay the welcome tour".
- **Getting started:** an empty My list suggests ideas (a book, something cozy, ...) and asks for 3 wishes, with a progress bar until the third, which gets confetti.
- **Ideas and suggestions:** an idea about someone is private to its author. "Share as a suggestion" shows it to everyone in the family except the person it's for, who never gets it from the API.
- **Autofill:** pasting a link calls `/api/preview`, which reads the product name and price from JSON-LD, Open Graph tags, or Amazon's markup. Stores that block bots fall back to a name guessed from the URL.
- **Photo search:** `/api/identify` sends a shrunk photo to Gemini (`GEMINI_MODEL` in `wrangler.jsonc`) with Google Search turned on, for up to 4 matches. Each match gets a store link: the brand's own site first, then retailers in `src/stores.js`, then Amazon. Amazon ranks with the retailers only when the page shows it is shipped and sold by Amazon. Every link is opened to confirm it is a real product page (or, if the store blocks bots, that Google Search really returned it). Marketplaces and resellers are never linked. With no confirmed page, the link searches the likeliest store instead. Search grounding is billed per search after 5,000 free a month. If search isn't available (free plan, search quota, or daily limit), it retries without search, so you still get names and store-search links. To keep token cost down, `src/gemini.js` asks for medium image resolution and low thinking (dropped automatically if a model rejects them), and waits out per-minute rate limits up to twice before giving up. Errors say which limit was hit; the raw Gemini error is in `wrangler tail` and the browser console. Photos are not stored.
- **Photos:** pasting a link saves the store's product photo with the item (`image_url`, hotlinked, never copied). Items saved before that, or whose link changed, get their photo looked up once in the background (`POST /api/image`). With no photo, the tile shows a small drawing picked from the item's name (perfume bottle, book, sweater, headphones, gift box, and so on). Columns added in `migrations/0005_item_images.sql`.
- **Someone's list:** a summary (wishes, still available, and top picks or what you're getting; no price range, so nobody gets called out for pricey lists), category chips with counts, price-range chips, a "Still available only" switch, and sort (top picks first, lowest or highest price, newest). Filters reset when you open a different person. Cards show photo, price, category, when it was added, the owner's note in its own box, and a gold Top pick ribbon.
- **Categories:** the owner can pick one in Add details (`items.category`, migration 0006); otherwise it's guessed from the title (`CAT_RULES` in `public/index.html`). The list must match `CATEGORIES` in `src/wishlist.js`.
- **Missing prices:** a wish with a link but no price gets its price read from the store page once, in the same background lookup as photos (`POST /api/image`, `price_checked_at`). It only fills an empty price, so the owner's own price always wins.
- **Just me (drafts):** every new wish starts in a private "Just me" section at the top of My list, for ideas you aren't sure about yet. Only you can see them: the API never returns drafts to anyone else, they don't count toward your wish count, and they can't be marked purchased. Tap Publish (with a confirm) to move one to your wish list. Publishing is one way: a published wish can't go back to Just me, only be edited or removed. Top pick and per-family hiding only apply to published wishes. Column `items.draft` (`migrations/0010_just_me.sql`); existing wishes stay published.
- **Profile:** Settings opens with Your profile: name, birthday (month and day, no year), sizes (shirt, pants, shoe, ring) and dislikes and allergies (shown as "Avoid"). Family sees it as a "Good to know" card at the top of your list, with a countdown when your birthday is within 45 days. Columns `members.birthday`, `sizes` (JSON), `avoid` (migration 0009).
- **Nicknames:** on someone's list, the Edit button sets your nickname for them and your budget for them in one sheet. The nickname lets you call them what you call them ("Grandma" instead of "Jane Doe"). Only you see it: the API swaps names for the viewer's nicknames everywhere (family, lists, "is getting this", budget, Excel), and the real name still shows in small text. Table `nicknames` (`migrations/0003_nicknames.sql`).
- **Profile photos:** set in Settings (your own only). The app crops it to a 256px square JPEG and saves it as a data URL in `members.photo` (migration 0008). `GET /api/photo?m=<id>&v=<photo_at>` serves it with a long cache; a new photo gets a new `v`. No photo shows the colored initial.
- **Budget:** your private budget per person per occasion, what you're getting them, and your open ideas. A switch flips between Christmas (everyone) and Birthdays (soonest first, plus who hasn't added one). The Excel export is for the view you're on. The URL hash is `#budget` (the old `#notes` still works).
- **More than one family:** in Settings, join another family by code, start a new one, invite, or leave one (not your last). You stay one person with one list. Each wish has a "Who can see this" switch per family; a wish hidden from a family is never shown through that family (`item_hidden`, migration 0004), though anyone who shares another family with you where it isn't hidden still sees it. The Family tab shows a section per family. Joining is blocked if that family already has someone with your name. Opening an invite link while signed in opens Settings with the code filled in.
- **Tabs:** My list, Family, a raised center Add a wish button (adds to Just me from any screen), Budget, Settings.
- **Settings:** text size (Default, Large, Extra large) and appearance (Automatic, Light, Dark) are saved on the device.
- **Look and motion:** cream background, a wine header band, burgundy actions, gold for top picks, pine for "you're getting this". Fraunces for titles and big numbers, Figtree for everything else. Animations mark real moments (opening an invite, joining, the tour, adding a wish, starring a top pick, "I'll get this" confetti, budget numbers counting) and all turn off with the device's Reduce Motion setting.

## Schema changes

Add a new numbered file in `migrations/`. The deploy command applies it on merge (or run `npm run migrate` by hand before deploying). The new code must not go live before its migration.

## History

Moved out of [personal-tools](https://github.com/adavidson21/personal-tools) (was `tools.alexisdavidson.org/wishlist/`) in November 2026. It uses the same D1 database, so anything created there is still here.
