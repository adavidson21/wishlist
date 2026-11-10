// One number for everyone in a household, honest "shared with", who changed it, and "not buying for" together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, xmasCode } from "./harness.mjs";

const X = xmasCode();
async function occ(w, who, subject, code = X) {
  const t = await w.api(who, "GET tracker");
  return t.people.find((x) => x.id === subject.id)?.occasions.find((o) => o.code === code) || null;
}
function setup() {
  const w = world();
  const family = w.circle("Family");
  const books = w.circle("Book club");
  const work = w.circle("Mike's work");
  const alexis = w.person("Alexis", { circles: [family, books] });
  const mike = w.person("Mike", { circles: [family, work] });
  const maria = w.person("Maria", { circle: family });
  const nolan = w.person("Nolan", { circle: work }); // only Mike shares a circle with Nolan
  const sue = w.person("Sue", { circle: books }); // only Alexis shares a circle with Sue
  const davidsons = w.household([alexis, mike]);
  // The household is in Family only (switched off for the other circles).
  w.run("DELETE FROM group_households WHERE household_id = ? AND group_id != ?", davidsons, family);
  w.run("DELETE FROM group_members WHERE direct = 0 AND group_id != ?", family);
  const garcias = w.household([maria, nolan]);
  // Nolan isn't in Family: the Garcias household is only in Mike's work circle there.
  w.run("DELETE FROM group_households WHERE household_id = ? AND group_id = ?", garcias, family);
  w.run("DELETE FROM group_members WHERE member_id = ? AND group_id = ?", nolan.id, family);
  return { w, alexis, mike, maria, nolan, sue, davidsons, garcias };
}

test("both people in a household see the same spent for a household, even gifts for someone only one of them knows", async () => {
  const { w, alexis, mike, maria, nolan } = setup();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X });
  w.buy(alexis, w.item(maria, "Scarf", 3000));
  w.buy(mike, w.item(nolan, "Drill", 5000));
  const a = await occ(w, alexis, maria), m = await occ(w, mike, maria);
  assert.equal(a.spent_cents, 8000);
  assert.equal(m.spent_cents, 8000);
  assert.deepEqual({ count: a.unseen.count, cents: a.unseen.cents }, { count: 1, cents: 5000 }, "Alexis sees an amount for Nolan, no title");
  assert.deepEqual(a.unseen.byBuyer, { [mike.id]: 5000 });
  assert.ok(!a.purchases.some((x) => x.title === "Drill"));
});

test("a budget for someone only you know isn't shared, and isn't labeled shared", async () => {
  const { w, alexis, mike, sue } = setup();
  await w.api(alexis, "POST budget", { subjectId: sue.id, amount: "30", occasion: X });
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM household_budgets")[0].n, 0);
  const t = await w.api(alexis, "GET tracker");
  const p = t.people.find((x) => x.id === sue.id);
  assert.equal(p.shared, false);
  assert.equal(p.occasions.find((o) => o.code === X).budget_cents, 3000);
  assert.ok(!(await w.api(mike, "GET tracker")).people.some((x) => x.id === sue.id));
});

test("an older shared budget for someone only you know still shows", async () => {
  const { w, alexis, sue, davidsons } = setup();
  w.run("INSERT INTO household_budgets (household_id, target, season, amount_cents) VALUES (?, ?, ?, 4500)", davidsons, `m:${sue.id}`, X);
  assert.equal((await occ(w, alexis, sue)).budget_cents, 4500);
});

test("shows who else last set a shared budget", async () => {
  const { w, alexis, mike, maria } = setup();
  await w.api(mike, "POST budget", { subjectId: maria.id, amount: "150", occasion: X });
  assert.equal((await occ(w, alexis, maria)).budget_by, "Mike");
  assert.equal((await occ(w, mike, maria)).budget_by, null);
});

test("saving over a change someone else just made asks first; older apps save as before", async () => {
  const { w, alexis, mike, maria } = setup();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X, was: null });
  await w.api(mike, "POST budget", { subjectId: maria.id, amount: "150", occasion: X, was: 20000 });
  const r = await w.call(alexis, "POST budget", { subjectId: maria.id, amount: "250", occasion: X, was: 20000 });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.detail.conflict, { amount_cents: 15000, by: "Mike" });
  assert.equal((await occ(w, alexis, maria)).budget_cents, 15000, "nothing saved");
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "250", occasion: X, was: 15000 });
  assert.equal((await occ(w, alexis, maria)).budget_cents, 25000);
  await w.api(mike, "POST budget", { subjectId: maria.id, amount: "100", occasion: X }); // no `was`: an older app
  assert.equal((await occ(w, alexis, maria)).budget_cents, 10000);
});

test("your own changes never ask", async () => {
  const { w, alexis, maria } = setup();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X });
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "220", occasion: X, was: 1 });
});

test("not buying for someone: both of you, or just you", async () => {
  const { w, alexis, mike, maria, garcias } = setup();
  await w.api(alexis, "POST budget/skip", { target: `h:${garcias}`, skip: true, both: true });
  assert.equal((await w.api(mike, "GET tracker")).people.find((p) => p.id === maria.id).skipped, true);
  await w.api(alexis, "POST budget/skip", { target: `h:${garcias}`, skip: false, both: true });
  assert.equal((await w.api(mike, "GET tracker")).people.find((p) => p.id === maria.id).skipped, false);
  await w.api(alexis, "POST budget/skip", { target: `m:${maria.id}`, skip: true });
  assert.equal((await w.api(mike, "GET tracker")).people.find((p) => p.id === maria.id).skipped, false, "just me");
  assert.equal((await w.api(alexis, "GET tracker")).people.find((p) => p.id === maria.id).skipped, true);
});

test("history doesn't show your household's gifts for someone you don't know", async () => {
  const { w, alexis, mike, nolan } = setup();
  w.run("INSERT INTO gift_history (kind, ref_id, season, subject_id, buyer_id, title, created_at) VALUES ('item', 'x', 20251225, ?, ?, 'Drill', '2025-12-01')", nolan.id, mike.id);
  const h = await w.api(alexis, "GET history");
  assert.equal(h.gifts.length, 0);
  assert.equal((await w.api(mike, "GET history")).gifts.length, 1);
});
