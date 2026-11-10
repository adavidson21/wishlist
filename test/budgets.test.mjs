// Shared household budgets (migration 0029). See docs/plans/household-budgets.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, xmasCode } from "./harness.mjs";

const X = xmasCode();
// The tracker's Christmas occasion for someone, as `who` sees it.
async function xmas(w, who, subject) {
  const t = await w.api(who, "GET tracker");
  const p = t.people.find((x) => x.id === subject.id);
  return p?.occasions.find((o) => o.code === X) || null;
}

// The family: the Davidsons (Alexis, Mike) and the Garcias (Maria, Nolan), plus Olivia on her own.
function family() {
  const w = world();
  const c = w.circle("Family");
  const alexis = w.person("Alexis", { circle: c });
  const mike = w.person("Mike", { circle: c });
  const maria = w.person("Maria", { circle: c });
  const nolan = w.person("Nolan", { circle: c });
  const olivia = w.person("Olivia", { circle: c });
  const davidsons = w.household([alexis, mike]);
  const garcias = w.household([maria, nolan]);
  return { w, c, alexis, mike, maria, nolan, olivia, davidsons, garcias };
}

test("a household shares one Christmas budget for another household, and both see each other's purchases", async () => {
  const { w, alexis, mike, maria, nolan } = family();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X });
  w.buy(alexis, w.item(maria, "Scarf", 3000));
  w.buy(mike, w.item(nolan, "Drill", 5000));
  for (const who of [alexis, mike]) {
    const o = await xmas(w, who, maria);
    assert.equal(o.budget_cents, 20000, `${who.name} sees the budget`);
    assert.equal(o.spent_cents, 8000, `${who.name} sees both purchases`);
  }
});

test("budgets for people inside your own household stay personal", async () => {
  const { w, alexis, mike } = family();
  await w.api(alexis, "POST budget", { subjectId: mike.id, amount: "100", occasion: X });
  assert.equal((await xmas(w, alexis, mike)).budget_cents, 10000);
  const t = await w.api(mike, "GET tracker");
  assert.ok(!t.people.some((p) => p.id === mike.id), "Mike never sees himself in the planner");
});

test("someone with no household keeps budgets personal", async () => {
  const { w, olivia, maria, alexis } = family();
  await w.api(olivia, "POST budget", { subjectId: maria.id, amount: "50", occasion: X });
  assert.equal((await xmas(w, olivia, maria)).budget_cents, 5000);
  assert.equal((await xmas(w, alexis, maria)).budget_cents, null);
});

test("the person a budget is for never sees it", async () => {
  const { w, alexis, maria } = family();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X });
  const t = await w.api(maria, "GET tracker");
  for (const p of t.people) for (const o of p.occasions) assert.notEqual(o.budget_cents, 20000);
});
