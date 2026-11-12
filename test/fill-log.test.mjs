// The fill log (migration 0052, docs/plans/autofill-hardening.md step 1): every lookup leaves one row with the store
// and what came back (never a person or a link), the owner sees hit rates in Settings > Inbox, scripts/fill-check.mjs
// can run a link through the live Worker with a secret, and the overnight check notifies the owner when a store
// fails twice in a row.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { world, SHOP } from "./worker-harness.mjs";

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.close())));
const GONE = "https://gone.hints-test.com/p/Cozy-Wool-Socks"; // the test network answers 404 for anything but SHOP

async function setup(vars) {
  const w = await world(vars);
  worlds.push(w);
  const A = await w.start("Alexis", "1111", "Fam"); // first person on Hints: the owner
  return { w, A };
}
const rows = async (w, kind) => (await (await w.db()).prepare("SELECT * FROM fill_log WHERE kind = ? ORDER BY id").bind(kind).all()).results;

test("each Fill leaves one row with the store and what came back, and nothing about the person or link", async () => {
  const { w, A } = await setup();
  const ok = await A.api("preview", { url: `${SHOP}Cozy-Mug?utm_source=x` });
  assert.equal(ok.title, "Cozy-Mug");
  assert.deepEqual(Object.keys(ok.fill).sort(), ["http", "ms", "page", "source"]);
  const miss = await A.api("preview", { url: GONE });
  assert.equal(miss.guessed, true);

  const [a, b] = await rows(w, "fill");
  assert.equal(a.host, "shop.hints-test.com");
  assert.equal(a.source, "page");
  assert.equal(a.page, "ok");
  assert.equal(a.http, 200);
  assert.deepEqual([a.name, a.photo, a.price], [1, 1, 1]);
  assert.ok(a.ms >= 0);
  assert.equal(b.host, "gone.hints-test.com");
  assert.equal(b.source, "guess");
  assert.equal(b.page, "gone");
  assert.equal(b.name, 0, "a name guessed from the link doesn't count as a name");

  const cols = (await (await w.db()).prepare("PRAGMA table_info(fill_log)").all()).results.map((c) => c.name);
  for (const c of cols) assert.doesNotMatch(c, /member|url|link|title|ip/i, `fill_log.${c} could identify someone`);
  const all = JSON.stringify(await rows(w, "fill"));
  assert.doesNotMatch(all, /Cozy|utm|Alexis/);
});

test("the owner sees hit rates per store; nobody else can", async () => {
  const { w, A } = await setup();
  const code = (await A.api("me")).groups[0].code;
  const M = await w.join(code, "Mike", "2222");
  await A.api("preview", { url: `${SHOP}Lamp` });
  await M.api("preview", { url: `${SHOP}Rug` });
  await M.api("preview", { url: GONE });

  const s = await A.api("fill/stats");
  assert.equal(s.days, 7);
  assert.equal(s.all.fills, 3);
  assert.equal(s.all.name, 67);
  const shop = s.stores.find((r) => r.host === "shop.hints-test.com");
  assert.deepEqual([shop.fills, shop.name, shop.photo, shop.price], [2, 100, 100, 100]);
  const gone = s.stores.find((r) => r.host === "gone.hints-test.com");
  assert.deepEqual([gone.fills, gone.name, gone.guess], [1, 0, 100]);
  assert.ok(Array.isArray(s.checks));

  const r = await M.raw("fill/stats");
  assert.equal(r.status, 404);
});

test("fill/check runs a link with the secret, and doesn't exist without it", async () => {
  const { w } = await setup();
  const call = (key) => w.mf.dispatchFetch("https://hints.test/api/fill/check", {
    method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "10.9.9.9", ...(key ? { "x-fill-check": key } : {}) },
    body: JSON.stringify({ url: `${SHOP}Desk-Lamp` }),
  });
  assert.equal((await call("whatever-key-123456")).status, 404, "no secret set: no route");

  await w.vars({ FILL_CHECK_KEY: "a-long-test-secret-key" });
  assert.equal((await call("a-long-test-secret-key-wrong")).status, 404);
  const res = await call("a-long-test-secret-key");
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.title, "Desk-Lamp");
  assert.equal(d.found, true);
  assert.equal(d.price, 19.99);
  assert.equal(d.source, "page");
  assert.equal((await rows(w, "check")).length, 1);
  assert.equal((await rows(w, "fill")).length, 0, "checks stay out of the people's numbers");
});

test("overnight checks go one store per run, and the owner hears once when a store fails twice in a row", async () => {
  const golden = [
    { store: "Good Shop", host: "shop.hints-test.com", links: [`${SHOP}Lamp`, `${SHOP}Rug`] },
    { store: "Broken Store", host: "gone.hints-test.com", links: [GONE] },
  ];
  const { w, A } = await setup({ PUSH_DEV_HOUR: "2", FILL_DEV_GOLDEN: JSON.stringify(golden) });
  await A.subscribe();

  await w.cron();
  await w.cron();
  await w.cron(); // both checked within 20 hours: nothing left to do
  let checks = await rows(w, "canary");
  assert.equal(checks.length, 2);
  assert.deepEqual(checks.map((c) => c.host).sort(), ["gone.hints-test.com", "shop.hints-test.com"]);

  // A day later, both are due again.
  await (await w.db()).prepare("UPDATE fill_log SET at = ? WHERE kind = 'canary'").bind(new Date(Date.now() - 21 * 3600_000).toISOString()).run();
  await w.cron();
  await w.cron();
  checks = await rows(w, "canary");
  assert.equal(checks.length, 4);

  const status = (await A.api("fill/stats")).checks;
  assert.deepEqual(status.map((c) => [c.store, c.failing]), [["Good Shop", 0], ["Broken Store", 2]]);
  assert.equal(status[0].last.ok, true);
  assert.equal(status[1].last.page, "gone");
  assert.equal(A.pushes().length, 0, "nothing at night");

  await w.vars({ PUSH_DEV_HOUR: "10" });
  await w.cron();
  await w.cron();
  const got = A.pushes().filter((p) => p.tag === "canary");
  assert.equal(got.length, 1, "once a day");
  assert.equal(got[0].title, "A test link for Broken Store is gone");
  assert.equal(got[0].url, "/#settings/inbox");
});
