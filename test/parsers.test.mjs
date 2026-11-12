// The autofill parsers (src/wishlist.js `parsers`) on store-shaped pages in test/fixtures/. Fast: no Worker, no
// database. Add a case whenever a store's markup trips autofill up (scripts/save-fixture.mjs saves a real page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsers } from "../src/wishlist.js";

const { jsonLdProduct, toPrice, cleanLink, cleanTitle, titleFromPath, pageCurrency, meta } = parsers;
const page = (name) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");

test("Target-shaped page: product under @graph, store name trimmed from the title", () => {
  const html = page("shaped-target");
  const ld = jsonLdProduct(html);
  assert.equal(ld.title, "Stanley 20oz Stainless Steel H2.0 FlowState Quencher Tumbler");
  assert.equal(ld.price, 35);
  assert.equal(ld.currency, "USD");
  assert.equal(ld.brand, "Stanley");
  assert.equal(ld.inStock, true);
  assert.match(ld.image, /^https:\/\/target\.scene7\.com\//);
  const raw = html.match(/<title>([^<]*)<\/title>/)[1];
  assert.equal(cleanTitle(raw, "www.target.com", meta(html, "og:site_name")), "Stanley 20oz Stainless Steel H2.0 FlowState Quencher Tumbler");
});

test("Amazon-shaped page: title cleanup drops 'Amazon.com:' and the category", () => {
  const html = page("shaped-amazon");
  assert.deepEqual(jsonLdProduct(html), {});
  const raw = html.match(/<title>([^<]*)<\/title>/)[1].replace(/&amp;/g, "&");
  assert.equal(cleanTitle(raw, "www.amazon.com", null), "YETI Rambler 14 oz Mug, Vacuum Insulated");
  // previewLink reads Amazon's price from the a-offscreen span with this pattern.
  assert.equal(toPrice(html.match(/class=["']a-offscreen["'][^>]*>\s*\$?([\d,.]+)/i)?.[1]), 30);
});

test("messy JSON-LD: CDATA, a raw line break, trailing commas, mainEntity, and a similar-products list that loses", () => {
  const ld = jsonLdProduct(page("shaped-messy-ld"));
  assert.equal(ld.title?.replace(/\s+/g, " "), "Cozy Knit Throw");
  assert.equal(ld.price, 64.5, "the first offer with a real amount wins, an empty one is skipped");
  assert.equal(ld.image, "https://littleshop.example/throw.jpg");
});

test("variants: a ProductGroup's price comes from its variant's priceSpecification", () => {
  const ld = jsonLdProduct(page("shaped-variants"));
  assert.equal(ld.title, "Merino Crew Sweater");
  assert.equal(ld.price, 89);
  assert.equal(ld.brand, "Woolly Co");
  assert.equal(ld.inStock, false);
});

test("Open Graph only (small Shopify store): European price format and currency", () => {
  const html = page("shaped-og-only");
  assert.deepEqual(jsonLdProduct(html), {});
  assert.equal(meta(html, "og:title"), "Men's Wool Runners");
  assert.equal(toPrice(meta(html, "product:price:amount", "og:price:amount")), 1299);
  assert.equal(pageCurrency(html, {}), "EUR");
  assert.equal(cleanTitle("Men's Wool Runners – Allbirds", "www.allbirds.com", "Allbirds"), "Men's Wool Runners");
});

test("Etsy-shaped page: AggregateOffer lowPrice, contentUrl photo, ' - Etsy' trimmed", () => {
  const html = page("shaped-etsy");
  const ld = jsonLdProduct(html);
  assert.equal(ld.price, 14.95);
  assert.equal(ld.image, "https://i.etsystatic.com/whale.jpg");
  assert.equal(ld.brand, "WoodWhaleShop");
  assert.equal(cleanTitle(html.match(/<title>([^<]*)<\/title>/)[1], "www.etsy.com", "Etsy"), "Personalized Whale Ornament, Custom Name Keepsake");
});

test("a bot check page has no product", () => {
  assert.deepEqual(jsonLdProduct(page("shaped-bot-check")), {});
});

test("toPrice reads the first amount in the formats stores use", () => {
  assert.equal(toPrice("$5, was $40"), 5);
  assert.equal(toPrice("1.299,00"), 1299);
  assert.equal(toPrice("12,50"), 12.5);
  assert.equal(toPrice("$1,299.99"), 1299.99);
  assert.equal(toPrice(19.99), 19.99);
  assert.equal(toPrice("USD 45"), 45);
  assert.equal(toPrice(""), null);
  assert.equal(toPrice("Free"), null);
  assert.equal(toPrice(0), null);
  assert.equal(toPrice("2,000,000"), null, "a million or more isn't a gift price");
});

test("cleanLink drops tracking, keeps variants, trims Amazon to /dp/ASIN", () => {
  assert.equal(cleanLink("https://www.amazon.com/YETI-Rambler-Insulated/dp/B0B64FXNLV/ref=sr_1_3?keywords=yeti&qid=1&th=1&psc=1&tag=x-20"),
    "https://www.amazon.com/dp/B0B64FXNLV");
  assert.equal(cleanLink("https://www.target.com/p/-/A-88403445?preselect=88403445&utm_source=google&gclid=abc#lnk=sametab"),
    "https://www.target.com/p/-/A-88403445?preselect=88403445");
  assert.equal(cleanLink("https://shop.example.com/products/tee?variant=123&size=M&color=navy&fbclid=zz"),
    "https://shop.example.com/products/tee?variant=123&size=M&color=navy");
  assert.equal(cleanLink("https://www.walmart.com/ip/41004852?athbdg=L1600&from=/search"), "https://www.walmart.com/ip/41004852");
});

test("titleFromPath makes a readable guess from the link, and skips IDs", () => {
  assert.equal(titleFromPath(new URL("https://www.amazon.com/Cozy-Slippers-Memory-Foam/dp/B0ABCDEF12")), "Cozy Slippers Memory Foam");
  assert.equal(titleFromPath(new URL("https://www.walmart.com/ip/41004852")), null);
  assert.equal(titleFromPath(new URL("https://www.target.com/p/stanley-20oz-quencher/-/A-88403445")), "Stanley 20oz quencher");
});
