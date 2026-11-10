# Plan: Activity feed on the Circles tab

Status: shipped Nov 9, 2026.

## Goal

The Circles tab becomes the social side of Hints. A feed shows what your people are up to, and anyone can share
something to it with a comment, like a post.

1. **Automatic activity:** "Sam added 3 wishes" (with photos), "Grandma updated her profile: new photo, Loves".
2. **Posts:** write something to your circle, optionally sharing an activity card with it ("omg this is so you 😂").
3. **Reactions and comments** on every card.

## Decisions (Nov 9, 2026)

- Feed posts and comments are visible to everyone who can see the card, **including the person a post is about**.
  Secret talk stays in the hidden chat. The composer says so.
- The feed lives on the **Circles tab**: a Feed / People switch at the top. Feed is the default.
- Reactions: yes, one per person per card, from a small fixed set: ❤️ 😂 😍 🎁 🔥.

## Hard rules

- **$0.** D1 and the Worker only. No new services.
- **No spoilers, ever.** The feed never mentions claims, purchases, group gifts, budgets, ideas or the hidden chat.
- **Same privacy as the API.** Every wish shown passes `ITEM_VISIBLE` for the viewer (drafts, wishes hidden from
  your circles, held and received ones never show). A wish removed or hidden later drops out of old cards too,
  because the check happens when the feed is read, not when the card was made. A card with no wishes left is skipped.
- **Only people you share a circle with.** You see cards from people you share a circle with (and your own). A post
  sent to one circle only shows to that circle. Comments and reactions only show from people you share a circle with,
  so someone in your sister's other circle never shows up by name.
- **Nicknames** apply, same as everywhere else.
- **Never noisy.** Wishes added close together are one card. Profile edits within a few hours are one card. Only
  changes people care about count (photo, cover, bio, Loves, Nopes, sizes, favorite colors, brands, gift style,
  already has). Removing a photo or changing a PIN, name or birthday never posts anything.

## Data model (migration `0043_feed.sql`)

```sql
CREATE TABLE feed (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT NOT NULL REFERENCES members(id),
  kind       TEXT NOT NULL,           -- 'wishes' | 'profile' | 'post'
  group_id   TEXT,                    -- posts sent to one circle; NULL = all the actor's circles
  body       TEXT,                    -- post text
  share_id   TEXT,                    -- post: the card it shares (no FK, it may be gone)
  meta       TEXT,                    -- JSON. wishes: {"items":[ids]}; profile: {"fields":[...]}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,           -- bumped when more wishes or edits join the card; the feed sorts on it
  edited_at  TEXT,
  deleted_at TEXT
);
CREATE INDEX feed_actor ON feed(actor_id, kind, updated_at);
CREATE INDEX feed_updated ON feed(updated_at);

CREATE TABLE feed_comments (
  id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES members(id),
  body TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX feed_comments_feed ON feed_comments(feed_id, created_at);

CREATE TABLE feed_reactions (
  feed_id TEXT NOT NULL, member_id TEXT NOT NULL REFERENCES members(id), emoji TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (feed_id, member_id)
);
```

## How cards get made

- **Wishes:** `POST item/publish` and a new wish saved straight to the list (someone you look after) call
  `feedWish(ownerId, itemId)`. If the owner has a wishes card updated in the last 2 hours (and started in the last
  12), the wish joins it (deduped, up to 30) and `updated_at` moves up. Otherwise a new card.
- **Profile:** `POST profile` snapshots the watched columns before and after, and calls `feedProfile(who, fields)`
  with what really changed. Same joining rule with a 6 hour window. A new photo counts, a removed one doesn't.
- **Posts:** `POST feed/post`.
- The actor is always whose list or profile it is, also when a manager makes the change for someone they look after.

## API

| Route | What |
|---|---|
| `GET feed?before=ISO` | 20 cards the viewer may see, newest first, plus `next` (cursor) when there's more. |
| `POST feed/post` | `{ body, shareId?, groupId? }`. Body up to 500 characters, required unless sharing a card. Can't share a post. |
| `POST feed/edit` | `{ id, body }`. Your own post. |
| `POST feed/delete` | `{ id }`. Any card of yours (posts, and automatic ones you'd rather not show). |
| `POST feed/react` | `{ id, emoji }`. Same emoji again or `null` clears it. |
| `GET feed/comments?id=` | All comments on a card. |
| `POST feed/comment` | `{ id, body }`. |
| `POST feed/comment/delete` | `{ id }`. Your own comment, or any comment on your card. |
| `GET feed/reactions?id=` | Who reacted with what. |

Each card comes back as:

```js
{ id, kind, actor: { id, name }, at, mine, circle: { id, name } | null,
  body, edited,                       // posts
  items: [{ id, title, image_url, price_cents }], more,   // wishes (first 4 plus how many more)
  fields: ["photo", "likes"],         // profile
  shared: <card> | { gone: true } | null,                // post sharing a card
  reactions: { counts: { "❤️": 2 }, mine: "❤️" | null, total },
  comments: { count, latest: [{ id, author: { id, name }, body, at, mine }] } }  // latest 2
```

## Notifications

- New kind `feed` ("Comments", on by default): the card's owner gets "Sam commented on your post" with the comment
  text, tag `feed:<id>` so a burst replaces itself, never for your own comment. Reactions don't notify.
- Uses `pushTo`, so quiet hours hold it until 8 am.

## Cleanup

- Nightly (hour 3 run): cards, comments and reactions older than 180 days are deleted.
- `deleteMember`: their cards, comments and reactions go. A circle that's deleted takes its circle-only posts.

## App

- **Circles tab:** "Waiting to join" and "Catch up" stay on top, then a Feed / People switch (remembered on the
  device). People is today's list, unchanged.
- **Feed:** a "Share something with your circle" box on top, then cards:
  - avatar, name, what happened, time ("2h", "Yesterday"), circle name when a post went to one circle;
  - wishes: a row of up to 4 photos (tap opens their list and flashes that wish), "+3 more";
  - profile: chips for what changed, tap opens their page;
  - posts: text, and the shared card inside a soft box;
  - a bar with React (long list picker of the 5 emojis), Comment, and Share (wishes and profile cards only);
  - reaction summary ("❤️😂 3", tap for who), latest 2 comments, "View all 5 comments".
- **Sheets:** the composer (text, circle picker when you're in more than one, the shared card preview, a note that
  everyone in the circle sees it, including who it's about), and a card's comments with a box to add one.
- **Your own card:** a ••• menu with Edit (posts) and Remove.
- **Empty feed:** "Nothing here yet. When your people add wishes or update their profiles, it shows up here."
- **Paging:** "Show more" at the bottom.
- Settings > Notifications gets the Comments switch.

## Testing

- Local: `npx wrangler d1 migrations apply wishlist --local`, `npx wrangler dev`, then a script that starts a circle,
  joins two more people and checks:
  - publishing 3 wishes in a row makes one card with 3 wishes;
  - a draft never shows; a wish hidden from the only shared circle doesn't show to that person; unpublishing removes it
    from the card; a card with nothing visible is skipped;
  - a profile photo + Loves edit makes one card with both fields; a PIN change makes nothing;
  - posts to one circle don't show to people only in another; comments from people you don't share a circle with
    are hidden;
  - react, change, clear; comment, delete own, owner deletes someone's comment, others can't;
  - deleting an account removes its cards.
- Browser: open the Circles tab, post, react, comment, share a card, on a phone-sized window, light and dark.
- `npm run check`.

## Later (not in this build)

- A "new" dot on the Feed switch.
- Sharing a single wish straight from someone's list.
- Birthday cards in the feed.
