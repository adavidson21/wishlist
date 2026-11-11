# Native apps vs staying a PWA, and Add to Hints from the Share button

Status: staying a PWA (decided Nov 9, 2026). Both free sharing fixes are built.

## Decision

Hints stays a PWA. The family is 4 households, Web Push and app badges already work (iPhone from the home screen app,
iOS 16.4+), and native apps would break the $0 rule (Apple Developer Program $99/year, Google Play $25 once) and add
app review and more codebases.

Similar apps exist (Giftster is the closest, WishlyBox has hidden "Gift Rooms" chats), but none match the circles,
households, nicknames, per-circle hiding and drafts.

## The gap: sharing a product into Hints

| Platform | How | Cost |
|---|---|---|
| Android, desktop Chrome/Edge | `share_target` in `public/manifest.webmanifest` (Hints shows in the Share menu once installed) | $0 |
| iPhone, iPad | The **Add to Hints** Shortcut and `POST /api/quickadd` | $0 |

### How the iPhone Shortcut works

- Settings > **Add from the Share button** (shown on iPhone and iPad) makes a personal add key (`hk_` + 40 characters).
  Only its SHA-256 is stored (`members.add_key_hash`, migration 0038). Making a new key or turning it off kills the old one.
- The Shortcut posts the shared text (a link, or "Check out X! https://...") with the key in the `x-hints-key` header.
- `POST /api/quickadd` (no device sign-in) finds the link, fills it in like the Fill button, and saves it to **Maybe**
  (a draft), so nobody is notified and nobody sees it until it's published. If the store blocks the lookup, it saves a
  guessed name and the app's details refresh tries again later.
- It answers with one plain sentence ("Added to your Maybe list in Hints: Cozy Wool Socks", "Already in Hints",
  or what went wrong), which the Shortcut shows as a notification.
- Limits: 30 an hour and 100 a day per person (`quickAddPerMember`), plus the usual autofill limit and the 300 wish cap.

### Make the Shortcut (once, on an iPhone)

1. Shortcuts app > **+** > name it **Add to Hints**.
2. Tap the **(i)** button > turn on **Show in Share Sheet**. Set the accepted types to **URLs**, **Text** and **Safari web pages**.
   Optional: "If there's no input" > **Get Clipboard**, so running it from the Shortcuts app adds a copied link.
3. Add **Get Contents of URL**:
   - URL: `https://hints.alexisdavidson.org/api/quickadd`
   - Method: **POST**
   - Headers: `x-hints-key` = your add key
   - Request Body: **JSON**, one Text field `text` = **Shortcut Input**
4. Add **Show Notification** with **Contents of URL** as the text.
5. Test it: open a product in Safari > Share > **Add to Hints**. It should say "Added to your Maybe list".

### Share it with the family (so nobody has to build it)

1. In the Shortcut's **(i)** > **Setup** (Import Questions): add a question for the `x-hints-key` header value,
   prompt "Paste your Hints add key (Settings > Your list > Add from the Share button)". **This keeps your own key out of the shared copy.**
2. Share > **Copy iCloud Link**.
3. Put the link in `SHORTCUT_URL` in `public/index.html`. The Settings card then shows **Get the Shortcut** instead of
   the build steps, and setup becomes: Set it up > Copy key > Get the Shortcut > paste the key.

## When to revisit native

- The Shortcut isn't good enough for the family on iPhone. Next step would be a Capacitor wrapper for iOS only
  ($99/year) with a real share extension.
- Hints opens up to people outside the family and needs to be found in the app stores.
- A feature comes up that only native can do (home screen widgets).
