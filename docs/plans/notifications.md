# Plan: Notifications

Status: building (Nov 2026).

## Problem

Nothing tells people when something changes. They only see new wishes if they open the app, and nothing reminds anyone that a birthday is coming up.

## What it does

Free Web Push (no paid service, no email). Turned on per device in **Settings > App > Notifications**.

What you can get, each with its own switch:

- **New wishes:** "Sam added 2 wishes", at most once an hour (an hourly digest, so adding 10 wishes is one notification).
- **Birthdays and Christmas:** "Sam's birthday is in 2 weeks" (14 and 3 days before). For Christmas, on Dec 1 and Dec 18, but only if you still need gifts: "Christmas is in 7 days. Still need a gift for Sam and Jen."
- **Group gifts:** "Alexis started a group gift for Sam: Stand mixer. Chip in?" Never sent to the person the gift is for.

Tapping a notification opens the right screen (their list, or Circles). All of it respects the usual privacy rules: you're only told about people you share a circle with, only about wishes you can see, and never about your own gifts.

### iPhone

Apple only allows web notifications from an app on the home screen (iOS 16.4 or later). In Safari, Settings shows "Add Hints to your home screen first" with a link to the install steps.

## How

- **Keys:** VAPID keys are made automatically the first time they're needed and kept in D1 (`app_keys`), so there's no setup. Pushes are signed (ES256 JWT) and encrypted (RFC 8291, aes128gcm) with WebCrypto in the Worker, no libraries.
- **Schedule:** one Cron Trigger every hour (`0 * * * *` in `wrangler.jsonc`, free). Each run sends the new-wish digest; the 9am New York run also sends birthday and Christmas reminders. A `push_sent` table stops a reminder going out twice.
- **Group gifts** are sent right when the group gift starts.
- Subscriptions the push service says are gone (404/410) are deleted.

## Data

Migration `0024_push.sql`: `push_subs` (endpoint, member, keys), `app_keys`, `push_sent`, and `members.notify` (JSON switches; missing = all on).

## API

- `GET push/key`, `POST push/subscribe`, `POST push/unsubscribe`, `POST push/prefs`, `POST push/test`.
- `GET me` adds `me.notify`.

## App

- `public/sw.js` shows the notification and opens the app on tap.
- Settings > App > Notifications: turn on for this device, the three switches, Send a test, turn off.
