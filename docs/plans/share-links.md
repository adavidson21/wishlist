# Plan: Share a list outside your circle

Status: shipped (Nov 2026).

## Problem

Some people who buy gifts aren't in the circle (a coworker, Grandma's friend, a teacher). Today the only way to show them a list is a screenshot.

## What it does

- **My list > Share outside your circle** makes a private link like `hints.alexisdavidson.org/s/x7k...`. Anyone with it sees a simple read-only page: your name, your wishes (photo, price, link), your gift cards, and your sizes, loves and favorite brands.
- **What's left out:** drafts (Maybe), wishes hidden from any of your circles, notes, nopes and allergies. The page never says what's been bought, so it's safe if you open your own link.
- **Turn off** kills the link. **New link** replaces it (the old one stops working).
- Managers can share the list of someone they look after, from the card on that person's page.
- The page asks anyone getting something to tell whoever shared the link, has a small "Made with Hints" footer, and is marked `noindex` so search engines skip it.

## Not in this round

Letting outsiders mark "I'm getting this". Their marks would have to show up somewhere the owner can't see, and the link has no way to tell the owner apart from anyone else.

## Data

Migration `0036_share_links.sql`: `members.share_token` (unique).

## API

- `POST share/link` `{ on, as? }`: makes a new link or turns it off. Returns `{ token }`.
- `GET me` adds `me.shareToken`. `GET list` adds `shareToken` for people you look after.
- `GET /s/:token` (worker) renders the page server-side, with a per-IP rate limit.
