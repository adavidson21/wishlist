# Plan: Compare prices across stores (free only)

Status: parked (Nov 2026). Not prioritized yet.

## Goal

On an item (wish or gift idea), show a small "Compare prices" section listing a few major retailers with what
each charges right now, so:

- a buyer can pick the cheapest store, and
- an owner can see when something on their own list is on sale somewhere else.

## Hard rule: it must cost $0

Every source below has a free allowance. The feature must enforce hard caps in code so it **stops** when an
allowance runs out instead of billing. When a cap is hit, the section says "Check back later" (or just hides).
No paid plans, no card on file for any of these services.

## Sources (all free)

| Source | Covers | Free allowance | Notes |
|---|---|---|---|
| SerpApi, Google Shopping engine | Many retailers in one call | 250 searches/month, 50/hour, no card | Main source. One call returns offers from many stores. |
| Walmart Affiliate API (walmart.io) | Walmart only | Free developer account | Walmart blocks our Worker from reading its pages, so this fills that gap. |
| Best Buy Developer API | Best Buy only | Free API key (approval) | Optional. Electronics heavy lists only. |
| Store pages read directly | Whichever stores allow it | Free | Already done by `livePrice()` in `src/wishlist.js`. |
| Gemini + Google Search | Fallback | 5,000 searches/month free on Gemini 3.x | Only if the above miss. Needs its own hard cap well under 5,000. |

Ruled out:

- **Amazon Creators API** (PA-API replacement): needs 10 qualifying affiliate sales in 30 days. Not realistic.
- **Keepa, PriceAPI, ShopSavvy, Rainforest, etc.**: paid only (around $49/month and up).

Verify the free allowances above before building. They were checked Nov 2026 and these change.

## How it works

### 1. Find matches once per item (expensive step, rare)

When someone first opens Compare on an item:

1. Build a query from the item: title, plus brand/model/size/color if known (`items.size`, `items.color`).
2. Call SerpApi Google Shopping with that query (1 search).
3. Keep up to ~5 offers from known stores (`STORES` in `src/stores.js`, plus Amazon), cheapest first, one per store.
4. If Walmart isn't in the results, try the Walmart Affiliate API search (free).
5. Save the matched **product links per store** in D1 so we never need to search again for this item.

### 2. Refresh prices cheaply (common step)

After matches are saved, refreshing a price should not spend a search:

- Read each saved store link with the existing `livePrice()` path (free, cached 12h at the edge).
- Walmart: Affiliate API lookup by item id (free).
- Only re-run the SerpApi search when the item's title or link changes, or a saved link dies (404 / no price
  several times in a row).

### 3. Show it

Item detail sheet, under the price:

```
Compare prices                 checked 2h ago
Target        $24.99   ↓ cheapest
Walmart       $26.48
Amazon        $27.00
```

- Rows link out to the store.
- Label as "Similar at <store>" when the match is not confident (title words don't line up with the item, or
  different size/color). Matching the exact product is the hard part; never claim a weak match is the same item.
- On someone else's list, highlight a store cheaper than the listed price by $1+ (same rule as `liveLine()`).
- On your own list, an optional "On sale elsewhere" badge on the tile when a saved match is cheaper.

## Staying free: caps and caching

- **Search budget table in D1** (`search_budget`: provider, month, used). Increment before each paid-tier-capable
  call; refuse when at the cap. Caps: SerpApi 230/month (leave headroom), Gemini compare lookups 2,000/month.
- **Hourly cap** for SerpApi: 40/hour (its limit is 50).
- **On demand only.** No background sweeps over all items. A search runs only when a person opens Compare.
- **One search per item, ever** (until title/link changes). Results shared with everyone in the circle.
- **Debounce**: if two people open the same item at once, the second waits for the first (edge cache key per item).
- Rough budget: ~200 items in the family circle means at most ~200 searches total to match everything once,
  spread over the season. That fits 250/month.

## Data model (migration)

```sql
-- price_matches: stores where an item (or idea) is sold, found once and refreshed cheaply.
CREATE TABLE price_matches (
  kind TEXT NOT NULL,            -- 'item' | 'idea'
  ref_id TEXT NOT NULL,          -- items.id or private_ideas.id
  store TEXT NOT NULL,           -- key from STORES, or 'amazon'
  url TEXT NOT NULL,
  title TEXT,                    -- the store's product name, for the "Similar" check
  price_cents INTEGER,
  confident INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,  -- refreshes with no price; drop the row after 3
  checked_at TEXT,
  PRIMARY KEY (kind, ref_id, store)
);
CREATE TABLE price_match_runs (  -- when we last searched for an item, and for which title/link
  kind TEXT NOT NULL, ref_id TEXT NOT NULL, query TEXT, searched_at TEXT,
  PRIMARY KEY (kind, ref_id)
);
CREATE TABLE search_budget (provider TEXT NOT NULL, month TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, month));
```

## API

- `POST /api/compare { kind, id }`: same visibility rules as `POST prices`. Returns saved matches with live
  prices; runs the one-time search if there are none and budget allows. Returns `{ matches, limited: true }`
  when capped.

## Secrets

Add to `.dev.vars.example` and Cloudflare: `SERPAPI_KEY`, `WALMART_CONSUMER_ID`, `WALMART_PRIVATE_KEY`
(+ key version), optionally `BESTBUY_API_KEY`. The feature hides itself when keys are missing.

## Build order

1. Migration + budget helper (`spend(env, provider)` returns false at cap).
2. SerpApi search + match picking, behind `POST /api/compare`. Log one line per run like `preview`/`live` do.
3. Compare section on the item sheet.
4. Walmart Affiliate API (search + lookup).
5. "On sale elsewhere" badge on your own list.
6. Optional: Best Buy API, Gemini fallback with its own cap.

## Open questions

- Is 250/month enough in peak December? If not, the cap makes it degrade, never bill. Could add Bright Data's
  free SERP credits as a second source if it supports Shopping results (unverified).
- Should owners be able to tap a cheaper store to switch their wish's link to it?
