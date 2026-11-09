# Plan: Household page and pets

Status: shipped (Nov 9, 2026). README "Household pages and pets" is the source of truth now.

## Decisions (Nov 9, 2026)

1. **Pets are not people.** No list, no login, no birthday reminders, no chat. Just info for gift-givers.
2. **Pets live on the household,** listed once instead of on each member's profile.
3. **People without a household can still have pets.** Their pets go on their own profile.
4. **Households get their own page** (`#household/<id>`).
5. **Visibility:** anyone who shares a circle with someone in the household (or with the person).
6. **Editing:** people in the household and a circle's admin (same as the rest of the household). A solo person's
   pets: that person, plus whoever looks after them if they don't use the app.
7. **Photos:** each pet can have one. Without a photo it shows its kind's emoji.
8. **Moving:** joining a household brings your pets in; the last person to leave a household takes its pets.

## Later, maybe

- Pet chips on the Circles tab.
- Shipping address on the household page (needs its own visibility decision first).
