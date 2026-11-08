// Stores photo search may link to. Order of preference: the brand's own site, then these retailers,
// with Amazon ranked like them only when a page shows it is shipped and sold by Amazon itself.
// `search` builds the fallback link used when no product page could be confirmed.

const q = encodeURIComponent;

export const STORES = {
  target: { name: "Target", hosts: ["target.com"], search: (s) => `https://www.target.com/s?searchTerm=${q(s)}` },
  walmart: { name: "Walmart", hosts: ["walmart.com"], search: (s) => `https://www.walmart.com/search?q=${q(s)}` },
  bestbuy: { name: "Best Buy", hosts: ["bestbuy.com"], search: (s) => `https://www.bestbuy.com/site/searchpage.jsp?st=${q(s)}` },
  costco: { name: "Costco", hosts: ["costco.com"], search: (s) => `https://www.costco.com/CatalogSearch?keyword=${q(s)}` },
  kohls: { name: "Kohl's", hosts: ["kohls.com"], search: (s) => `https://www.kohls.com/search.jsp?search=${q(s)}` },
  macys: { name: "Macy's", hosts: ["macys.com"], search: (s) => `https://www.macys.com/shop/search?keyword=${q(s)}` },
  nordstrom: { name: "Nordstrom", hosts: ["nordstrom.com"], search: (s) => `https://www.nordstrom.com/sr?keyword=${q(s)}` },
  homedepot: { name: "Home Depot", hosts: ["homedepot.com"], search: (s) => `https://www.homedepot.com/s/${q(s)}` },
  lowes: { name: "Lowe's", hosts: ["lowes.com"], search: (s) => `https://www.lowes.com/search?searchTerm=${q(s)}` },
  wayfair: { name: "Wayfair", hosts: ["wayfair.com"], search: (s) => `https://www.wayfair.com/keyword.php?keyword=${q(s)}` },
  crateandbarrel: { name: "Crate & Barrel", hosts: ["crateandbarrel.com"], search: (s) => `https://www.crateandbarrel.com/search?query=${q(s)}` },
  williamssonoma: { name: "Williams Sonoma", hosts: ["williams-sonoma.com"], search: (s) => `https://www.williams-sonoma.com/search/results.html?words=${q(s)}` },
  rei: { name: "REI", hosts: ["rei.com"], search: (s) => `https://www.rei.com/search?q=${q(s)}` },
  dicks: { name: "Dick's Sporting Goods", hosts: ["dickssportinggoods.com"], search: (s) => `https://www.dickssportinggoods.com/search/SearchDisplay?searchTerm=${q(s)}` },
  zappos: { name: "Zappos", hosts: ["zappos.com"], search: (s) => `https://www.zappos.com/search?term=${q(s)}` },
  sephora: { name: "Sephora", hosts: ["sephora.com"], search: (s) => `https://www.sephora.com/search?keyword=${q(s)}` },
  ulta: { name: "Ulta", hosts: ["ulta.com"], search: (s) => `https://www.ulta.com/search?search=${q(s)}` },
  barnesandnoble: { name: "Barnes & Noble", hosts: ["barnesandnoble.com"], search: (s) => `https://www.barnesandnoble.com/s/${q(s)}` },
  gamestop: { name: "GameStop", hosts: ["gamestop.com"], search: (s) => `https://www.gamestop.com/search/?q=${q(s)}` },
  lego: { name: "LEGO", hosts: ["lego.com"], search: (s) => `https://www.lego.com/en-us/search?q=${q(s)}` },
  apple: { name: "Apple", hosts: ["apple.com"], search: (s) => `https://www.apple.com/us/search/${q(s)}` },
  // rh=p_6:ATVPDKIKX0DER limits Amazon search results to items sold by Amazon.com.
  amazon: { name: "Amazon", hosts: ["amazon.com"], search: (s) => `https://www.amazon.com/s?k=${q(s)}&rh=p_6%3AATVPDKIKX0DER` },
};

export const STORE_KEYS = Object.keys(STORES);

// Never link here, even if the AI offers it or claims it is the brand's site.
const BLOCKED = ["ebay.com", "etsy.com", "poshmark.com", "mercari.com", "depop.com", "temu.com", "aliexpress.com",
  "alibaba.com", "shein.com", "wish.com", "dhgate.com", "stockx.com", "goat.com", "craigslist.org", "facebook.com",
  "offerup.com", "grailed.com", "thredup.com", "vinted.com"];

const onHost = (host, domain) => host === domain || host.endsWith("." + domain);

export const isBlocked = (host) => BLOCKED.some((d) => onHost(host, d));
export const storeFor = (host) => Object.entries(STORES).find(([, s]) => s.hosts.some((d) => onHost(host, d)))?.[0] || null;
export const isBrandHost = (host, brandDomain) => !!brandDomain && onHost(host, brandDomain);

// A brand domain from the AI is only trusted if it looks like a plain domain and isn't a marketplace.
export function cleanBrandDomain(v) {
  const d = String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || isBlocked(d)) return "";
  return d;
}

export const PROMPT_STORE_LIST = Object.values(STORES).filter((s) => s.name !== "Amazon").map((s) => s.name).join(", ");
