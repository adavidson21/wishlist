// The autofill golden set: real product links for the stores people add from most (docs/plans/autofill-hardening.md,
// step 1). Used by the daily check (fillCanary() in src/wishlist.js, one link per store per day, rotating) and by
// `node scripts/fill-check.mjs`, which runs all of them against the live Worker.
//
// Pick long-lived products (classic LEGO sets, KitchenAid mixers, Crayola) so links don't die every season. When the
// check says a link is "gone" (404), swap in another product from the same store. Aim for about 10 per store.
export const GOLDEN = [
  {
    store: "Amazon", host: "amazon.com", links: [
      "https://www.amazon.com/dp/B0F5CHKX4F", // Crayola 64 crayons with case
      "https://www.amazon.com/dp/B0B64FXNLV", // YETI Rambler 14 oz mug
      "https://www.amazon.com/dp/B098YXCY64", // YETI Rambler Colster
      "https://www.amazon.com/dp/B09WNK39JN", // Echo Pop
      "https://www.amazon.com/dp/B09X27YPS1", // Echo Auto
    ],
  },
  {
    store: "Target", host: "target.com", links: [
      "https://www.target.com/p/stanley-20oz-stainless-steel-h2-0-flowstate-quencher-tumbler/-/A-88403445",
      "https://www.target.com/p/crayola-64ct-ultra-clean-washable-crayons/-/A-51989849",
      "https://www.target.com/p/stanley-40-oz-stainless-steel-quencher-pro-tour-tumbler/-/A-94760810",
      "https://www.target.com/p/stanley-30-oz-stainless-steel-h2-0-flowstate-quencher-tumbler-black/-/A-94448634",
      "https://www.target.com/p/-/A-92355219", // Stanley 64 oz Quencher
    ],
  },
  {
    store: "Walmart", host: "walmart.com", links: [
      "https://www.walmart.com/ip/41004852", // LEGO Classic Small Creative Bricks 10692
      "https://www.walmart.com/ip/129342255", // LEGO Classic Medium Creative Brick Box 10696
      "https://www.walmart.com/ip/40996357", // LEGO Classic Large Creative Brick Box 10698
      "https://www.walmart.com/ip/seort/428358546", // LEGO Classic Bricks on a Roll 10715
      "https://www.walmart.com/ip/seort/941189477", // LEGO Classic Bricks and Wheels 11014
    ],
  },
  {
    store: "Etsy", host: "etsy.com", links: [
      "https://www.etsy.com/listing/480491867", // Love You A Ton whale ornament
      "https://www.etsy.com/listing/252431542", // Baby's first Christmas deer ornament
      "https://www.etsy.com/listing/1628613181", // Bernedoodle ornament
      "https://www.etsy.com/listing/1320215074", // Family Christmas ornament
      "https://www.etsy.com/listing/1115558049", // Personalized ornament
    ],
  },
  {
    store: "Kohl's", host: "kohls.com", links: [
      "https://www.kohls.com/product/prd-1392420/kitchenaid-ksm75-classic-plus-45-qt-stand-mixer.jsp",
      "https://www.kohls.com/product/prd-25941/kitchenaid-artisan-5-qt-stand-mixer.jsp",
      "https://www.kohls.com/product/prd-5689493/kitchenaid-k45ss-classic-series-45-qt-tilt-head-stand-mixer.jsp",
      "https://www.kohls.com/product/prd-7828738/kitchenaid-55-qt-bowl-lift-stand-mixer.jsp",
      "https://www.kohls.com/product/prd-6216696/kitchenaid-ksm70skxx-7-qt-bowl-lift-stand-mixer.jsp",
    ],
  },
  {
    store: "Shopify (Allbirds)", host: "allbirds.com", links: [
      "https://www.allbirds.com/products/mens-wool-runners",
      "https://www.allbirds.com/products/womens-wool-runners-hazy-cargo",
    ],
  },
];

// FILL_DEV_GOLDEN (tests and local runs only): a JSON array shaped like GOLDEN that replaces it.
export function goldenSet(env) {
  if (env?.FILL_DEV_GOLDEN) {
    try { const g = JSON.parse(env.FILL_DEV_GOLDEN); if (Array.isArray(g)) return g; } catch {}
  }
  return GOLDEN;
}
