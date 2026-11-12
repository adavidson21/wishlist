# Alexis Davidson brand 2.0.0: rules for coding agents

Read this before writing or reviewing UI for any of Alexis's apps (LifeKit, Hints, Workshop, Docket, Dispatch, Thrift,
Classroom, the personal site and anything new). Machine-readable companions, same folder:

- `tokens.json`: every token with its value in both themes and what it is for
- `components.json`: every component with classes, variants, states, ARIA, keyboard behavior and a snippet to copy
- `brand.css` (b- prefixed classes), `brand-compat.css` (v1 names), `tokens.css` (tokens only), `theme.js`

Live guide: https://tools.alexisdavidson.org/brand/

## Load it

```html
<script src="https://tools.alexisdavidson.org/brand/v2/theme.js"></script>
<link rel="stylesheet" href="https://tools.alexisdavidson.org/brand/v2/brand.css">
```

The script goes first, in `<head>`, without `defer`, so the saved theme applies before paint. Apps with a strict CSP
or offline needs copy the folder in: `node sync.mjs shared/brand --from https://tools.alexisdavidson.org/brand/v2`.

## Hard rules

1. **Use components before markup.** Find it in `components.json` and copy its snippet. Write new CSS only for what
   the catalog does not cover, and build it from tokens.
2. **Semantic tokens only.** `var(--accent)`, `var(--surface)`, `var(--fs-md)`, `var(--r-lg)`. Never a raw hex,
   rgb(), px font size, px radius, ms duration or shadow offset in app CSS. Never a `--p-*` primitive.
3. **Flat backgrounds.** No gradients, anywhere.
4. **One solid accent action per view** (`.b-btn.primary` or `.b-btn.cta`). Everything else is secondary, soft or quiet.
5. **Color means something.** Accent is action and selection. Pine (`--ok`) is done. Amber (`--warn`) is soon.
   Brick (`--danger`) is wrong or destructive. Topaz (`--gold`) is a highlight. Category tints `t0` to `t3` only
   group things and never stand for a status. Status always comes with a word or icon, not color alone.
6. **Garnet is the brand.** The wine band (`.b-hero`, `--hero`) and `--brand` are garnet in every app. An app may set
   its own accent with `data-accent` on `<html>` (or on the theme.js tag): `garnet` (default), `sapphire`,
   `tourmaline`, `amethyst`. No green accent: green means done.
7. **Light/dark toggle top right, from theme.js.** Never build another one. Every app supports both themes.
8. **Every nested page links back up** (LifeKit apps link to LifeKit).
9. **Keyboard first.** Every control is reachable by Tab, shows the focus ring, and works with Enter or Space.
   Never remove `:focus-visible` outlines.
10. **No real people in examples.** No employee names or titles in placeholders, fixtures or screenshots.

## States (every interactive component)

| State | How | Rule |
| --- | --- | --- |
| default | semantic tokens | clear hierarchy: one primary |
| hover | automatic | small step, 150ms; never the only way to show something |
| focus | automatic `:focus-visible` | 3px accent ring, 2px offset, instant |
| active | automatic | sticker press, instant |
| disabled | `aria-disabled="true"` (preferred) or `disabled` | muted, flat; prefer enabled plus a clear message |
| loading | `.busy` + `aria-busy="true"` | spinner, repeat clicks blocked |

Reduced motion is handled by the library: presses and slides become color and opacity changes.

## Scales

- Type: `--fs-xs` 12, `--fs-sm` 13, `--fs-md` 15, `--fs-base` 17, `--fs-lg` 19, `--fs-xl` 23, `--fs-2xl` 26,
  `--fs-3xl` 36, `--fs-display` 58 (px at 17px base; all shrink together in `.b-dense`)
- Weights: `--weight-body` 400, `--weight-ui` 600, `--weight-strong` 700, `--weight-eyebrow` 800
- Fonts: `--display` Bricolage Grotesque (titles, big numbers), `--sans` Figtree (everything else), `--mono` DM Mono
- Radius: `--r-xs` 6, `--r-sm` 10, `--r-md` 14, `--r-lg` 16 (cards, sheets, toasts), `--r-xl` 24, `--r-pill`
- Space: `--space-1` 4 through `--space-8` 48 (4, 8, 12, 16, 20, 24, 32, 48)
- Borders: `--bw-hair` 1, `--bw-base` 1.5, `--bw-heavy` 3. Sticker offsets: `--pop-sm` 2, `--pop-md` 3, `--pop-lg` 4, `--pop-xl` 5
- Motion: `--dur-fast` 150ms, `--dur-med` 200ms, `--dur-slow` 400ms, `--spring`, `--ease-out`
- Tap target: `--tap` 44px (34px in dense with a mouse)

## Work apps

Add `class="b-dense"` to `<body>` for 15px text and tighter targets on mouse screens.

## Reviewing a change

Flag: raw colors or sizes in CSS, `--p-*` use, a second primary action, missing labels or aria, removed focus
outlines, color-only status, gradients, a hand-made theme toggle, hover-only information.
