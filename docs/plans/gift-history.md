# Plan: Gift history

Status: building (Nov 2026).

## Problem

Budget and Purchases only show upcoming occasions. After Christmas there's no record of what you gave anyone, so it's easy to repeat a gift and hard to plan next year's budget.

## What it does

- **Budget > Past gifts:** everything you've given, by year, then occasion, then person, with what you spent and a total per year. Searchable by name or gift.
- **On someone's page:** "You've given Sam" with your last few gifts to them, and a See all link.
- Only your own gifts. Gifts from others in your household aren't included (they can see their own).
- Wishes, ideas, suggestions, group gift shares and gift cards all count. A group gift shows your share.

## How

When an occasion passes, the hourly Cron Trigger copies each purchase into `gift_history`: a snapshot of the title, link, photo, what you spent, and who it was for. It's a snapshot so it survives later edits and deletes. Removing a wish or idea snapshots first too, so nothing is lost in the gap before the next run.

## Data

Migration `0035_gift_history.sql`: `gift_history`, unique on (buyer, kind, ref, season). Kind is `item`, `idea` or `card`.

## API

`GET history` `{ member? }`: your gifts, newest first. With `member`, only gifts to them.
