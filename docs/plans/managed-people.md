# Plan: People you look after (managed profiles)

Status: shipped (Nov 2026).

## Problem

Kids and relatives who won't use the app can't have a list. Today everyone has to join with an invite code and pick their name on their own phone.

## What it does

- Anyone can add **someone who doesn't use the app** (a kid, a grandparent) from the Circles tab: a name and which circles they're in.
- That person shows up like everyone else: their list, birthday, Good to know card, and they count in Budget and "Still need a gift for".
- **Who can manage them:** the person who added them, plus anyone in the same household as them. Two parents can both run a kid's list by putting the kid in their household (adding someone puts them in your household automatically if you have one).
- Managers open the person's page and get: **Add a wish**, edit and remove wishes, **Edit profile** (name, birthday, sizes, loves, nopes, allergies, photo), and gift cards.
- Managers still see what's been bought, and can buy things themselves. The surprise rule protects the person whose list it is, and they aren't using the app. (A parent needs to know what's been bought for their kid anyway.)
- **Let them sign in** hands the list over: the person becomes a normal member who picks their name on the join screen. From then on the owner-never-sees-purchases rule applies to them like anyone else, and the managers lose edit rights.
- **Remove** takes them out of every circle (their data stays but nobody can see it).

## Rules

- Managed people never appear on the "tap your name" join screen, and nobody can sign in as them (by id or by typing their name) until they're handed over.
- They can't be a circle's admin (admin never passes to them, and it can't be handed to them).
- Wishes a manager adds go straight to the wish list (no Maybe), so the circle sees them right away. Top pick works. Per-circle hiding doesn't apply to managed lists.
- A manager editing someone's list doesn't make it "their own" list: the API checks `canManage` on every write.

## Data

Migration `0022_managed.sql`: `members.managed_by` (member id of whoever added them; NULL = signs in normally).

## API

- `POST managed/add` `{ name, groupIds? }` creates the person (default: all your circles) and puts them in your household if you have one.
- `POST managed/release` `{ memberId }` (Let them sign in) and `POST managed/remove` `{ memberId }`.
- `as: memberId` on `item/save`, `item/remove`, `giftcards/save` and `profile` acts for a managed person. `profile` never takes a PIN for them.
- `GET me` adds `managedBy` and `canManage` per person. `GET list` adds `canManage`.

## App

- Circles tab: "Add someone who doesn't use the app" under You, and "Looked after by you" (or by whom) under their name.
- Their page: a "You look after this list" card with Add a wish, Edit profile, Gift cards, Let them sign in, Remove. Edit on each wish.
- The Add sheet: picking them in "Who's it for?" offers "Add to their wish list" or a private idea.
