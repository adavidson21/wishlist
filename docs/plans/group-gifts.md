# Plan: Group gifts and "more than one"

Status: building (Nov 2026).

## Problem

A wish can only have one buyer. So people can't split a pricey gift ("Mom and I are going in on the stand mixer"), and a wish like "LEGO minifigures, as many as you like" is taken as soon as one person buys one.

## What it does

### How many (owner side)

- The wish form gets **How many?**: 1 (default), 2 to 10, or **As many as you like**.
- Others see "Wants 3" or "As many as you like" on the card, and "2 of 3 still needed" as people buy.
- Buying asks how many you're getting (up to what's left). The wish is taken once all are covered. "As many as you like" never runs out.

### Group gifts (buyer side)

- On any open wish, besides **I'll get this**, there's **Go in on it together**. That starts a group gift: it covers one of the wish, and you can say how much you're putting in (optional).
- Others see "Sam started a group gift · $40 of $120 so far" with **Chip in**. Chipping in adds you with your own amount.
- Everyone in the group gift sees who's in and the running total. Leaving is one tap. When the last person leaves, the wish is open again.
- A group gift uses one occasion: whoever joins goes with the occasion it was started for.
- Your share shows in your Budget and Purchases (and the Excel export) as your amount, labeled "Group gift". With no amount entered it counts as $0 so it doesn't inflate your total.

### Privacy (unchanged)

The list owner never sees any of this: not quantities bought, not group gifts, not who's in. Same rule as purchased marks today.

## Data

Migration `0023_group_gifts.sql`:

- `items.quantity` INTEGER, default 1. 0 means "as many as you like".
- `claims` is rebuilt so one wish can have several buyers per occasion: primary key `(item_id, season, buyer_id)` instead of `(item_id, season)`, plus `qty` (how many you're getting, default 1) and `chip_in` (1 = your row is a share of the group gift). Existing marks copy over as `qty = 1, chip_in = 0`.

A wish's taken count = the sum of `qty` on solo rows + 1 if it has a group gift.

## API

- `item/save` takes `quantity` (absent = unchanged).
- `claim` takes `qty` and `chipIn`. Starting a group gift needs one free; joining adopts the group's occasion. 409 when there aren't enough left.
- `GET list` (not the owner): each wish gets `gift: { quantity, taken, left, buyers, group }`. `claim` stays as before: your own mark, or a summary when the wish is fully taken, so filters like "Still available only" keep working.
- `GET tracker`: purchases add `qty` and `chipIn`.

## Not in this round

Group gifts on ideas and suggestions (they keep one buyer).
