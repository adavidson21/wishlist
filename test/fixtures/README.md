# Autofill parser fixtures

Pages `test/parsers.test.mjs` runs the autofill parsers on. Files starting with `shaped-` are hand-made, modeled on
how each store marks up its product pages (no store sends real pages to Cloudflare's or this repo's CI servers). Real
saved pages are better: from your own computer run `node scripts/save-fixture.mjs <product url> <name>`, then add a
case for it in `test/parsers.test.mjs`.
