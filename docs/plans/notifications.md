# Plan: Notifications

Status: shipped (Nov 2026).

## Problem

Nothing tells people when something changes. They only see new wishes if they open the app, and nothing reminds anyone that a birthday is coming up.

## What it does

Free Web Push (no paid service, no email). Turned on per device in **Settings > Notifications > Notifications**.

What you can get, each with its own switch:

- **New wishes:** "Sam added 2 wishes", at most once an hour (an hourly digest, so adding 10 wishes is one notification).
- **Birthdays and Christmas:** "Sam's birthday is in 2 weeks" (14 and 2 days before; the 2-day one names the weekday, "Sam's birthday is Tuesday"). For Christmas, on Dec 1 and Dec 18, but only if you still need gifts: "Christmas is in 7 days. Still need a gift for Sam and Jen."
- **Group gifts:** "Alexis started a group gift for Sam: Stand mixer. Chip in?" Never sent to the person the gift is for.
- **Your list:** from Nov 15, "Your list hasn't changed since last year" to the owner only, once a year, and not after Looks good on the My list card.
- **Chats:** "New message about Sam" (the sender and message text only with "Show message text" on, off by default, so nothing readable sits on a lock screen Sam might see). Never sent to the person the chat is about. One per unread stretch, so a busy thread doesn't buzz your phone for every message. Tapping it opens that chat.

Tapping a notification opens the right screen (their list, or Circles). All of it respects the usual privacy rules: you're only told about people you share a circle with, only about wishes you can see, and never about your own gifts.

### iPhone

Apple only allows web notifications from an app on the home screen (iOS 16.4 or later). In Safari, Settings shows "Add Hints to your home screen first" with a link to the install steps.

## How

- **Keys:** VAPID keys are made automatically the first time they're needed and kept in D1 (`app_keys`), so there's no setup. Pushes are signed (ES256 JWT) and encrypted (RFC 8291, aes128gcm) with WebCrypto in the Worker, no libraries.
- **Schedule:** one Cron Trigger every hour (`0 * * * *` in `wrangler.jsonc`, free). Each run sends the new-wish digest; the 9am New York run also sends birthday and Christmas reminders. A `push_sent` table stops a reminder going out twice.
- **Group gifts** are sent right when the group gift starts.
- Subscriptions the push service says are gone (404/410) are deleted.

## Data

Migration `0026_push.sql`: `push_subs` (endpoint, member, keys), `app_keys`, `push_sent`, and `members.notify` (JSON switches; missing = all on).

## API

- `GET push/key`, `POST push/subscribe`, `POST push/unsubscribe`, `POST push/prefs`, `POST push/test`.
- `GET me` adds `me.notify`.

## App

- `public/sw.js` shows the notification and opens the app on tap.
- Settings > Notifications > Notifications: turn on for this device, the three switches, Send a test, turn off.

## Follow-ups (Nov 8, 2026, migration 0027)

Decisions: birthday reminders at 14 and 2 days; quiet hours 9 pm to 8 am New York; Christmas countdown on Dec 1 and Dec 18; the stale list notification goes to the owner only.

- **Signing out ends a device's notifications.** Subscriptions store the device token that turned them on (`push_subs.device_token`). Nothing goes to a subscription whose sign-in is gone, the hourly run deletes them, and sign out unsubscribes the browser too. Before this, the next person to sign in on a shared phone kept getting the previous person's notifications, including chat text about themselves.
- **Quiet hours.** Nothing sends between 9 pm and 8 am. Group gift and chat notifications wait in `push_later` (newest per tag) for the 8 am run. The digest waits for morning.
- **Safer runs.** The digest's cursor moves only after everyone is handled, with a once-only key per person, so a failed run neither loses nor repeats a digest. Reminders run from 9 am until a run finishes the day (`app_keys.reminders_done`). Each run sends at most 35 (free plan request limit), and the VAPID token is reused per push service for an hour.
- **"New" badge everywhere.** `list_seen` keeps each viewer's "N new" counts on the server, the app copies its old local counts up once, and the home screen icon shows the total (`setAppBadge`). The digest carries the count so the icon updates while the app is closed.
- **Asking.** A snoozable card on My list and a card in the welcome tour, both only where notifications can be turned on right there.
- **Android icon.** `icons/badge.png`, a white H on transparent, for the status bar.
