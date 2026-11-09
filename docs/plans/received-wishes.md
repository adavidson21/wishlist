# Plan: Received wishes ("Did you get these?")

Status: shipped (Nov 2026).

## Problem

Purchase marks belong to an occasion and reset once it passes, but the wish stays on the list. So the sweater someone got Sam for Christmas shows as available again afterwards, and could be bought twice next year.

## What it does

- Once an occasion has passed, any wish that was marked for it is **held**: it drops off everyone's shopping view right away (so nobody buys it again), and the owner gets a **Did you get these?** card at the top of My list, labeled with the occasion ("From Christmas").
  - **Got it** moves the wish to **Received**.
  - **Still want it** puts it back on the list as a normal wish, and it won't be asked about again for that occasion.
  - **Got them all** answers every held wish at once.
- The owner never learns who marked what, or whether anyone did for a wish they didn't get. The card only says "these were on your list for Christmas". The surprise is over by then, but the giver stays the giver's business.
- A held wish nobody answers about is treated as received 30 days after the occasion.
- **Received** is a section at the bottom of My list: what you got, from which occasion, with a **Thanked** check for thank-you notes and **Put back on my list**.
- Wishes set to "As many as you like" are never held: they keep going.
- People you look after: their held wishes are received automatically after 30 days (there's nobody to ask), and their managers can see the Received section on their page.

## Rules

- Held = the wish has a mark for an occasion that's over and hasn't been answered for. It's computed in one `UPDATE` (`settleReceived()`) run hourly by the Cron Trigger and whenever the owner opens their list.
- A buyer with an active mark for a later occasion still sees a held wish (same as a removed wish).
- Removing a wish that has past marks now keeps it (soft remove), so gift history (next plan) survives.

## Data

Migration `0034_received.sql`, all on `items`:

- `held_season`: the occasion it's waiting on an answer for.
- `settled_season`: the last occasion answered.
- `received_at` and `received_season`: when it was received, and for which occasion.
- `thanked_at`: when the Thanked box was checked.

## API

- `POST item/got` `{ id?, all?, got, as? }`
- `POST item/thanked` `{ id, on, as? }`
- `POST item/unreceive` `{ id, as? }`
- `GET list` (yours): held wishes come back with `held: <season>`, plus a separate `received: [...]`.
