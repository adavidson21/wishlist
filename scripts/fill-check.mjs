// Runs every golden link (src/golden.js) through the live Worker's autofill, like tapping Fill, and prints a pass/fail
// table with timing. Run it before and after any autofill change (docs/plans/autofill-hardening.md, step 1).
//
//   FILL_CHECK_KEY=... node scripts/fill-check.mjs                 # all stores, Gemini allowed (like Fill)
//   FILL_CHECK_KEY=... node scripts/fill-check.mjs --no-ai         # the page only, no Gemini (free, shows what's blocked)
//   FILL_CHECK_KEY=... node scripts/fill-check.mjs --store target  # one store (matches the name or host)
//   FILL_CHECK_KEY=... node scripts/fill-check.mjs --base http://localhost:8787
//
// FILL_CHECK_KEY must match the Worker secret (`npx wrangler secret put FILL_CHECK_KEY`, 16+ characters). Each link
// with Gemini allowed can use one of the day's Google Search calls, so a full run uses up to ~30 of the 150.
import { GOLDEN } from "../src/golden.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const base = opt("base", "https://hints.alexisdavidson.org").replace(/\/$/, "");
const only = opt("store", "").toLowerCase();
const ai = !flag("no-ai");
const key = process.env.FILL_CHECK_KEY || "";
if (!key) {
  console.error("Set FILL_CHECK_KEY to the Worker's FILL_CHECK_KEY secret.");
  process.exit(2);
}

const set = GOLDEN.filter((g) => !only || g.store.toLowerCase().includes(only) || g.host.includes(only));
if (!set.length) { console.error(`No store matches "${only}".`); process.exit(2); }

async function check(url) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/fill/check`, {
      method: "POST", headers: { "content-type": "application/json", "x-fill-check": key }, body: JSON.stringify({ url, ai }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error("404: FILL_CHECK_KEY is wrong, or the Worker doesn't have it set");
    if (!res.ok) throw new Error(`${res.status}: ${data.error || "failed"}`);
    return data;
  } catch (err) {
    return { error: String(err.message || err), ms: Date.now() - started };
  }
}

// A few at a time: the Worker allows 240 API calls a minute per IP, and Gemini lookups are slow anyway.
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const jobs = set.flatMap((g) => g.links.map((url) => ({ g, url })));
console.log(`Checking ${jobs.length} links on ${base} (${ai ? "Gemini allowed, like Fill" : "page only, no Gemini"})...\n`);
const results = await pool(jobs, 3, async (j) => ({ ...j, r: await check(j.url) }));

const mark = (v) => (v ? "✓" : "·");
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
let fails = 0;
for (const g of set) {
  const rows = results.filter((x) => x.g === g);
  const ok = (f) => rows.filter((x) => !x.r.error && f(x.r)).length;
  const ms = rows.map((x) => x.r.ms || 0).sort((a, b) => a - b);
  console.log(`${g.store}  name ${ok((r) => r.found)}/${rows.length}  photo ${ok((r) => r.image)}/${rows.length}  price ${ok((r) => r.price != null)}/${rows.length}  half under ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s`);
  for (const { url, r } of rows) {
    if (r.error) { fails++; console.log(`  ✗ ${pad(url.replace(/^https?:\/\/(www\.)?/, ""), 60)} ${r.error}`); continue; }
    if (!r.found) fails++;
    const how = `${r.source}${r.page && r.page !== "ok" ? `, page ${r.page}${r.http ? ` ${r.http}` : ""}` : ""}`;
    console.log(`  ${r.found ? "✓" : "✗"} name ${mark(r.found)} photo ${mark(r.image)} price ${mark(r.price != null)}  ${pad(((r.ms || 0) / 1000).toFixed(1) + " s", 7)} ${pad(how, 26)} ${pad(r.title || "", 50)}`);
  }
  console.log("");
}
console.log(fails ? `${fails} link(s) got no name.` : "Every link got a name.");
process.exit(fails ? 1 : 0);
