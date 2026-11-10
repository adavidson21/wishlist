// Getting ready for strangers (migration 0046, docs/plans/public-launch.md): set-up lists and the circle link,
// wrong-PIN warnings and lockdown, Turnstile, the PIN pepper, Gemini allowances, passkeys and the owner's delete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { world } from "./harness.mjs";
import { runSchedule } from "../src/wishlist.js";
import { geminiAllowed, geminiCount, scope, LIMITS } from "../src/limits.js";

const basePin = (id, pin) => createHash("sha256").update(`wishlist:${id}:${pin}`).digest("hex");
const withPin = (w, p, pin) => w.run("UPDATE members SET pin_hash = ? WHERE id = ?", basePin(p.id, pin), p.id);
const codeOf = (w, g) => w.sql("SELECT join_code AS c FROM groups WHERE id = ?", g)[0].c;
const hour = () => Math.floor(Date.now() / 3_600_000) * 3600;

test("new circles don't hand a set-up list over from the circle link; older circles still do", async () => {
  const w = world();
  const c = w.circle("Book club");
  const ann = w.person("Ann", { circle: c });
  const bea = w.person("Bea", { circle: c, managedBy: ann });
  const r = await w.call(null, "POST join", { code: codeOf(w, c), memberId: bea.id, pin: "2222" });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Ann needs to send you your own link/);
  assert.equal(w.sql("SELECT managed_by FROM members WHERE id = ?", bea.id)[0].managed_by, ann.id, "still looked after");
  const look = await w.api(null, "POST lookup", { code: codeOf(w, c) });
  assert.equal(look.group.linkClaims, false);

  w.run("UPDATE groups SET link_claims = 1 WHERE id = ?", c);
  const ok = await w.call(null, "POST join", { code: codeOf(w, c), memberId: bea.id, pin: "2222" });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
});

test("wrong PINs are counted, and lots of them app-wide tighten sign-in to 3 tries", async () => {
  const w = world();
  const c = w.circle();
  const ann = w.person("Ann", { circle: c });
  withPin(w, ann, "1111");
  for (let i = 0; i < 3; i++) assert.equal((await w.call(null, "POST join", { code: codeOf(w, c), memberId: ann.id, pin: "9999" })).status, 403);
  const n = (k) => w.sql("SELECT SUM(count) AS n FROM rate_limits WHERE key LIKE ?", `${k}@%`)[0].n;
  assert.equal(n(`pinmiss:m:${ann.id}`), 3);
  assert.equal(n(`pinwarn:m:${ann.id}`), 1, "warned once");
  assert.equal((await w.call(null, "POST join", { code: codeOf(w, c), memberId: ann.id, pin: "1111" })).status, 200, "right PIN still works");

  const bob = w.person("Bob", { circle: c });
  withPin(w, bob, "1234");
  w.run("INSERT INTO rate_limits (key, bucket, count) VALUES ('pinmiss:all@3600', ?, ?) ON CONFLICT (key, bucket) DO UPDATE SET count = excluded.count", hour(), LIMITS.pinMissesPerHour);
  const tries = [];
  for (let i = 0; i < 4; i++) tries.push((await w.call(null, "POST join", { code: codeOf(w, c), memberId: bob.id, pin: "0000" })).status);
  assert.deepEqual(tries, [403, 403, 403, 429]);
});

test("with Turnstile set up, a person with recent wrong PINs is asked for the check", async () => {
  const w = world();
  w.env.TURNSTILE_SITE_KEY = "site-key";
  w.env.TURNSTILE_SECRET = "secret";
  const c = w.circle();
  const ann = w.person("Ann", { circle: c });
  withPin(w, ann, "1111");
  for (let i = 0; i < 3; i++) await w.call(null, "POST join", { code: codeOf(w, c), memberId: ann.id, pin: "9999" });
  const r = await w.call(null, "POST join", { code: codeOf(w, c), memberId: ann.id, pin: "1111" });
  assert.equal(r.status, 403);
  assert.equal(r.body.turnstile, "site-key");
});

test("PIN_PEPPER wraps old hashes without anyone's PIN, and sign-in keeps working", async () => {
  const w = world();
  const c = w.circle();
  const ann = w.person("Ann", { circle: c });
  withPin(w, ann, "1111");
  w.env.PIN_PEPPER = "pepper";
  await runSchedule(w.env);
  assert.match(w.sql("SELECT pin_hash AS h FROM members WHERE id = ?", ann.id)[0].h, /^p1:[0-9a-f]{64}$/);
  assert.equal((await w.call(null, "POST join", { code: codeOf(w, c), memberId: ann.id, pin: "1111" })).status, 200);
  assert.equal((await w.call(null, "POST join", { code: codeOf(w, c), memberId: ann.id, pin: "1112" })).status, 403);
  delete w.env.PIN_PEPPER;
  assert.equal((await w.call(null, "POST join", { code: codeOf(w, c), memberId: ann.id, pin: "1111" })).status, 503, "never a silent wrong PIN");
});

test("Gemini: per-person allowance, new accounts stop at 80%, search has its own cap, every request counts", async () => {
  const w = world();
  const env = { DB: w.env.DB, GEMINI_DAILY_CAP: "100", GEMINI_GROUNDED_CAP: "2" };
  const fresh = { id: "new1", createdAt: new Date().toISOString() };
  const old = { id: "old1", createdAt: "2025-01-01T00:00:00Z" };
  const as = (member, route, fn) => scope.run({ route, member }, fn);

  // A new account tapping things: 25 a day.
  for (let i = 0; i < LIMITS.geminiUserPerMember[1]; i++) await as(fresh, "POST name", () => geminiCount(env, false));
  assert.equal((await as(fresh, "POST name", () => geminiAllowed(env))).why, "person");
  // Its automatic allowance is separate.
  assert.equal((await as(fresh, "POST estimate", () => geminiAllowed(env))).ok, true);
  // Fill the app to 80%: new accounts stop, established ones and the schedule don't.
  for (let i = 0; i < 55; i++) await geminiCount(env, false);
  assert.equal((await as(fresh, "POST estimate", () => geminiAllowed(env))).why, "busy");
  assert.equal((await as(old, "POST name", () => geminiAllowed(env))).ok, true);
  assert.equal((await geminiAllowed(env)).ok, true);
  // Search: 2 a day here, all of it kept for taps (background work stops 50 earlier).
  assert.equal((await as(old, "POST name", () => geminiAllowed(env, { grounded: true }))).grounded, true);
  assert.equal((await as(old, "POST prices", () => geminiAllowed(env, { grounded: true }))).grounded, false, "background leaves search for taps");
  await geminiCount(env, true);
  await geminiCount(env, true);
  const g = await as(old, "POST name", () => geminiAllowed(env, { grounded: true }));
  assert.equal(g.ok, true);
  assert.equal(g.grounded, false, "runs without search");
  // The whole-app cap.
  for (let i = 0; i < 18; i++) await geminiCount(env, false);
  assert.equal((await geminiAllowed(env)).why, "app");
});

test("Gemini fails closed when the counters can't be read", async () => {
  const broken = { DB: { prepare() { throw new Error("db down"); } } };
  assert.equal((await geminiAllowed(broken)).ok, false);
});

test("passkeys: sign-in options use this host, challenges are one-time, and they go with Delete my Hints", async () => {
  const w = world();
  const c = w.circle();
  const ann = w.person("Ann", { circle: c });
  const start = await w.api(null, "POST passkey/start", {});
  assert.equal(start.options.rpId, "hints.test");
  const bad = await w.call(null, "POST passkey/signin", { id: start.id, response: { id: "nope" } });
  assert.equal(bad.status, 404);
  const again = await w.call(null, "POST passkey/signin", { id: start.id, response: { id: "nope" } });
  assert.equal(again.status, 400, "the challenge was used up");

  const mk = await w.api(ann, "POST passkey/new", {});
  assert.equal(mk.options.rp.id, "hints.test");
  assert.equal(mk.options.authenticatorSelection.residentKey, "required");
  w.run("INSERT INTO passkeys (id, member_id, public_key, created_at) VALUES ('cred1', ?, 'pk', '2026-01-01')", ann.id);
  assert.equal((await w.api(ann, "GET me")).me.passkeys.length, 1);
  withPin(w, ann, "1234");
  await w.api(ann, "POST account/delete", { pin: "1234" });
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM passkeys")[0].n, 0);
});

test("only whoever runs Hints can find and delete someone", async () => {
  const w = world();
  const c = w.circle();
  const owner = w.person("Alexis", { circle: c });
  const sam = w.person("Sam", { circle: c });
  assert.equal((await w.call(sam, "POST owner/find", { q: "al" })).status, 404);
  const found = await w.api(owner, "POST owner/find", { q: "sa" });
  assert.deepEqual(found.people.map((p) => p.name), ["Sam"]);
  assert.equal((await w.call(owner, "POST owner/delete", { memberId: owner.id })).status, 400, "not yourself");
  await w.api(owner, "POST owner/delete", { memberId: sam.id });
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM members WHERE id = ?", sam.id)[0].n, 0);
});

test("Gemini: trusted accounts only count toward the whole-app cap; background search stops early", async () => {
  const w = world();
  const env = { DB: w.env.DB, GEMINI_DAILY_CAP: "100", GEMINI_GROUNDED_CAP: "60" };
  const fam = { id: "fam1", createdAt: new Date().toISOString(), trusted: true };
  const as = (member, route, fn) => scope.run({ route, member }, fn);
  for (let i = 0; i < 90; i++) await as(fam, "POST name", () => geminiCount(env, false));
  assert.equal((await as(fam, "POST name", () => geminiAllowed(env))).ok, true, "no per-person limit, no 80% stop");
  for (let i = 0; i < 10; i++) await geminiCount(env, false);
  assert.equal((await as(fam, "POST name", () => geminiAllowed(env))).why, "app");

  const w2 = world();
  const env2 = { DB: w2.env.DB, GEMINI_GROUNDED_CAP: "60" };
  for (let i = 0; i < 10; i++) await geminiCount(env2, true);
  assert.equal((await as(fam, "POST prices", () => geminiAllowed(env2, { grounded: true }))).grounded, false, "background: 60 - 50 = 10");
  assert.equal((await as(fam, "POST preview", () => geminiAllowed(env2, { grounded: true }))).grounded, true, "taps still search");
});

test("the owner can raise and lower someone's AI limits; existing accounts start trusted", async () => {
  const w = world();
  const c = w.circle();
  const owner = w.person("Alexis", { circle: c });
  const sam = w.person("Sam", { circle: c });
  assert.equal((await w.call(sam, "POST owner/trust", { memberId: sam.id })).status, 404);
  await w.api(owner, "POST owner/trust", { memberId: sam.id });
  assert.equal(w.sql("SELECT ai_trusted AS t FROM members WHERE id = ?", sam.id)[0].t, 1);
  assert.equal((await w.api(owner, "POST owner/find", { q: "sam" })).people[0].trusted, true);
  await w.api(owner, "POST owner/trust", { memberId: sam.id, on: false });
  assert.equal(w.sql("SELECT ai_trusted AS t FROM members WHERE id = ?", sam.id)[0].t, 0);
  // The migration marks everyone already there as trusted (UPDATE runs before anyone new signs up).
  const sql = (await import("node:fs")).readFileSync(new URL("../migrations/0046_launch_hardening.sql", import.meta.url), "utf8");
  assert.match(sql, /UPDATE members SET ai_trusted = 1;/);
});
