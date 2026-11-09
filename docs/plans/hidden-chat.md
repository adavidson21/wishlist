# Plan: Hidden chat about a person ("the back channel")

Status: shipped (Nov 2026), including phone notifications (#44).

## Problem

Suggestions exist, but there's nowhere to talk about them. "I got the sweater, can someone get the matching
scarf?" and "Is she still a size M?" go back to the family group text, which is what Hints is meant to replace.

## What it does

On someone's page, a chat about that person that everyone in the circle can see **except that person**.
Messages can point at a specific wish or shared suggestion so the chat and the list stay connected.

## Decisions (Nov 8, 2026)

1. **One thread per person, per circle.** Keyed on `(group_id, subject_id)`. Family doesn't read the friend
   circle's chat about her. If you share more than one circle with someone, the chat sheet has circle chips.
2. **The subject knows nothing.** No message, count, badge or "chat exists" hint ever comes back to the person
   it's about. (They'll probably guess the family talks, but the app never confirms it.)
3. **Keep 6 months.** Messages older than 183 days are never returned and get swept by the app
   (`CHAT_KEEP_DAYS` in `src/wishlist.js`). No cron needed.
4. **Group gifts are out of scope here.** Built separately (`group-gifts.md`).

## Hard rules

- **Privacy is enforced in the API**, same as suggestions. `canSeeChat()` requires the viewer and the subject to
  both be in the circle, and the viewer not to be the subject. Every chat route goes through it.
- **Tags can't leak.** A tag must be one of their wishes that's published and not hidden from that circle, or a
  suggestion that's shared. Private ideas can't be tagged. If a tagged thing later disappears, the chip reads
  "re: a removed wish" and isn't clickable.
- **$0.** D1 and polling only (every 20 s while the chat is open and the tab is visible).
- **Simple for 18 to 70.** A text thread with quick starter questions, not a forum.

## How it works

### Data (migration `0025_chat.sql`)

- `chat_messages (id, group_id, subject_id, author_id, item_id, idea_id, body, created_at, edited_at, deleted_at)`.
  `item_id` and `idea_id` have no foreign key, since wishes and ideas can be hard deleted.
- `chat_reads (member_id, group_id, subject_id, last_read_at)` for unread counts.

### API (`src/wishlist.js`)

| Route | Does |
|---|---|
| `GET chat?member=&group=&after=` | The thread (newest 200 within 6 months). With `after`, only messages created, edited or removed since then (polling). Marks it read. Returns `admin` and `now` (next `after`). |
| `POST chat/send` | `{ group, member, body, itemId?, ideaId? }`. Max 500 characters. Rate limited (60/hour, 300/day per person). |
| `POST chat/edit` | `{ id, body }`. Your own message, within 15 minutes. |
| `POST chat/delete` | `{ id }`. Your own message, or any message if you're the circle's admin. Shows as "Message removed". |

Also:
- `GET me`: each person in each circle has `chatUnread` (always 0 for yourself).
- `GET list` on someone else's list: `chatCounts` (`"item:<id>"` / `"idea:<id>"` -> number of tagged messages).
  Never on your own list.

### App (`public/index.html`)

- **Their page:** a "Chat about Mom · Mom can't see this" bar at the top, with an unread count.
- **Every wish and suggestion card:** a chat button (with a count when there are tagged messages) that opens the
  chat with that item tagged.
- **Circles tab:** a gold "💬 2" badge next to anyone with unread messages.
- **Chat sheet:** bubbles with avatars and nicknames, Today / Yesterday / date dividers, tag chips that jump to
  the item on their page, quick starters ("What size?", "Does Mom still want this?", "Who's getting what?"),
  tap your own message for Edit / Remove (admins can remove anyone's). Enter sends on a computer; on phones
  Enter is a new line.

## Privacy checks (all passed against local D1, Nov 8, 2026)

- [x] Subject calls `GET chat` or `POST chat/send` about themselves: 404.
- [x] Subject's `GET me` shows `chatUnread: 0`, their own `GET list` has no `chatCounts`, and no message text
      appears in either response.
- [x] Someone in a different circle with the subject can't read this circle's thread, and vice versa.
- [x] Tagging a private idea or a draft wish fails.
- [x] A non-admin can't remove someone else's message; the admin can.
- [x] Edits and removals show up for others on their next poll.

## Phone notifications (shipped, #44)

- Everyone in the circle except the person it's about and the sender gets "Ann in the chat about Sam" with the
  message text, through the Web Push setup from `notifications.md` (`chatPosted()` in `src/wishlist.js`).
- Once per unread stretch: if you already have unread messages from the past week in that thread, you aren't
  pinged again until you open it. A new one replaces the last on the device (tag `chat:<circle>:<person>`).
- Quiet hours (9 pm to 8 am New York) hold it until 8 am. "Chats" switch in Settings > Notifications.
- Tapping it opens that chat (`#person/<id>/chat/<circle>`).
- Open question: the notification shows the message text and "chat about Sam" on the lock screen. If Sam picks up
  someone's phone, that's the one place the subject could see it. Option: leave the text out ("New message about
  Sam") or add a "Show message text" switch, off by default.

## Later

- **Occasion dividers** ("Christmas 2026") if date dividers aren't enough.
