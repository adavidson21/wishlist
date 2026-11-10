// Per-person split for Christmas household budgets, and gifts for several people in a household (migration 0047).
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, xmasCode } from "./harness.mjs";

const X = xmasCode();
async function occ(w, who, subject) {
  const t = await w.api(who, "GET tracker");
  return t.people.find((x) => x.id === subject.id)?.occasions.find((o) => o.code === X) || null;
}
function setup() {
  const w = world();
  const c = w.circle("Family");
  const alexis = w.person("Alexis", { circle: c });
  const mike = w.person("Mike", { circle: c });
  const ava = w.person("Ava", { circle: c });
  const maria = w.person("Maria", { circle: c });
  const nolan = w.person("Nolan", { circle: c });
  const olivia = w.person("Olivia", { circle: c });
  const davidsons = w.household([alexis, mike]);
  const garcias = w.household([ava, maria, nolan]); // by name: Ava, Maria, Nolan
  return { w, c, alexis, mike, ava, maria, nolan, olivia, davidsons, garcias };
}
const amounts = (o) => Object.fromEntries(Object.entries(o.people).map(([id, p]) => [id, p.budget_cents]));

test("turning split on divides the total evenly in whole dollars, leftover to the first people", async () => {
  const { w, alexis, ava, maria, nolan } = setup();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "100", occasion: X });
  await w.api(alexis, "POST budget/split", { subjectId: maria.id, occasion: X, on: true });
  const o = await occ(w, alexis, maria);
  assert.equal(o.split, true);
  assert.deepEqual(amounts(o), { [ava.id]: 3400, [maria.id]: 3300, [nolan.id]: 3300 });
  assert.equal(o.budget_cents, 10000);
});

test("editing one person changes only them and the total; turning off keeps the sum", async () => {
  const { w, alexis, mike, ava, maria, nolan } = setup();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "300", occasion: X });
  await w.api(alexis, "POST budget/split", { subjectId: maria.id, occasion: X, on: true });
  await w.api(mike, "POST budget", { subjectId: nolan.id, amount: "40", occasion: X, was: 10000 });
  const o = await occ(w, alexis, maria);
  assert.deepEqual(amounts(o), { [ava.id]: 10000, [maria.id]: 10000, [nolan.id]: 4000 });
  assert.equal(o.budget_cents, 24000);
  assert.equal(o.people[nolan.id].budget_by, "Mike");
  await w.api(alexis, "POST budget/split", { subjectId: maria.id, occasion: X, on: false });
  const off = await occ(w, mike, maria);
  assert.equal(off.split, undefined);
  assert.equal(off.budget_cents, 24000);
});

test("per-person amounts get the same conflict check", async () => {
  const { w, alexis, mike, maria } = setup();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "90", occasion: X });
  await w.api(alexis, "POST budget/split", { subjectId: maria.id, occasion: X, on: true });
  await w.api(mike, "POST budget", { subjectId: maria.id, amount: "50", occasion: X, was: 3000 });
  const r = await w.call(alexis, "POST budget", { subjectId: maria.id, amount: "60", occasion: X, was: 3000 });
  assert.equal(r.status, 409);
  assert.equal(r.body.detail.conflict.amount_cents, 5000);
});

test("a gift for the whole household counts evenly against each of them; for some, only those", async () => {
  const { w, alexis, ava, maria, nolan } = setup();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "300", occasion: X });
  await w.api(alexis, "POST budget/split", { subjectId: maria.id, occasion: X, on: true });
  await w.api(alexis, "POST idea/save", { subjectId: maria.id, alsoFor: [ava.id, nolan.id], title: "Board game", price: "50", bought: true, paid: "50", occasion: X });
  await w.api(alexis, "POST idea/save", { subjectId: maria.id, alsoFor: [nolan.id], title: "Wine", price: "25", bought: true, paid: "25", occasion: X });
  const o = await occ(w, alexis, maria);
  const spent = Object.fromEntries(Object.entries(o.people).map(([id, p]) => [id, p.spent_cents]));
  assert.ok(Math.abs(spent[ava.id] - 5000 / 3) < 0.001);
  assert.ok(Math.abs(spent[maria.id] - (5000 / 3 + 1250)) < 0.001);
  assert.ok(Math.abs(spent[nolan.id] - (5000 / 3 + 1250)) < 0.001);
  assert.ok(Math.abs(o.spent_cents - 7500) < 0.001, "the household total is what it all cost");
  const t = await w.api(alexis, "GET tracker");
  assert.ok(t.people.find((p) => p.id === ava.id).occasions.find((x) => x.code === X).purchases.some((x) => x.title === "Board game"));
});

test("a gift for several people has to be for one household", async () => {
  const { w, alexis, maria, olivia } = setup();
  const r = await w.call(alexis, "POST idea/save", { subjectId: maria.id, alsoFor: [olivia.id], title: "Mugs" });
  assert.equal(r.status, 400);
});

test("someone joining a split household brings their own amount (or starts with none); the total adds up", async () => {
  const { w, alexis, maria, olivia } = setup();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "90", occasion: X });
  await w.api(alexis, "POST budget/split", { subjectId: maria.id, occasion: X, on: true });
  await w.api(alexis, "POST budget", { subjectId: olivia.id, amount: "20", occasion: X });
  await w.api(maria, "POST household/add", { memberId: olivia.id });
  const id = (await w.api(olivia, "GET me")).me.householdInvites[0].id;
  await w.api(olivia, "POST household/answer", { id, accept: true });
  const o = await occ(w, alexis, maria);
  assert.equal(o.people[olivia.id].budget_cents, 2000);
  assert.equal(o.budget_cents, 11000);
});

test("someone leaving a split household takes their amount with them and the total drops", async () => {
  const { w, alexis, maria, nolan } = setup();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "90", occasion: X });
  await w.api(alexis, "POST budget/split", { subjectId: maria.id, occasion: X, on: true });
  await w.api(nolan, "POST household/remove", { memberId: nolan.id });
  assert.equal((await occ(w, alexis, maria)).budget_cents, 6000);
  assert.equal((await occ(w, alexis, nolan)).budget_cents, 3000);
});

test("the last one out of a split household can leave", async () => {
  const { w, alexis, ava, maria, nolan } = setup();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "90", occasion: X });
  await w.api(alexis, "POST budget/split", { subjectId: maria.id, occasion: X, on: true });
  for (const p of [ava, nolan, maria]) await w.api(p, "POST household/remove", { memberId: p.id });
  for (const p of [ava, maria, nolan]) assert.equal((await occ(w, alexis, p)).budget_cents, 3000);
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM household_budget_people")[0].n, 0);
});
