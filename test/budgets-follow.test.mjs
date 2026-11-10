// Budgets follow people when households change (household budgets plan, rule 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, xmasCode } from "./harness.mjs";

const X = xmasCode();
async function occ(w, who, subject, code = X) {
  const t = await w.api(who, "GET tracker");
  return t.people.find((x) => x.id === subject.id)?.occasions.find((o) => o.code === code) || null;
}
async function join(w, asker, who) {
  await w.api(asker, "POST household/add", { memberId: who.id });
  const id = (await w.api(who, "GET me")).me.householdInvites[0].id;
  return w.api(who, "POST household/answer", { id, accept: true });
}
function family() {
  const w = world();
  const c = w.circle("Family");
  const alexis = w.person("Alexis", { circle: c });
  const mike = w.person("Mike", { circle: c });
  const maria = w.person("Maria", { circle: c, birthday: "12-02" });
  const nolan = w.person("Nolan", { circle: c });
  const olivia = w.person("Olivia", { circle: c });
  const freddy = w.person("Freddy", { circle: c });
  const davidsons = w.household([alexis, mike]);
  const garcias = w.household([maria, nolan]);
  return { w, c, alexis, mike, maria, nolan, olivia, freddy, davidsons, garcias };
}

test("the last one out of a household with shared budgets can leave (no foreign key error)", async () => {
  const { w, alexis, mike, maria } = family();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X });
  await w.api(mike, "POST household/remove", { memberId: mike.id });
  const r = await w.call(alexis, "POST household/remove", { memberId: alexis.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM households")[0].n, 1, "only the Garcias are left");
});

test("joining a household brings your budgets for people outside it", async () => {
  const { w, alexis, mike, olivia, freddy } = family();
  await w.api(olivia, "POST budget", { subjectId: freddy.id, amount: "40", occasion: X });
  const r = await join(w, alexis, olivia);
  assert.deepEqual(r.kept, []);
  for (const who of [alexis, mike, olivia]) assert.equal((await occ(w, who, freddy)).budget_cents, 4000, who.name);
});

test("where the household already had a budget, it keeps its own and says so", async () => {
  const { w, alexis, olivia, maria } = family();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X });
  await w.api(olivia, "POST budget", { subjectId: maria.id, amount: "50", occasion: X });
  const r = await join(w, alexis, olivia);
  assert.deepEqual(r.kept, ["Maria & Nolan"]);
  assert.equal((await occ(w, olivia, maria)).budget_cents, 20000);
});

test("a budget your new household had for you becomes the setter's own", async () => {
  const { w, alexis, mike, olivia } = family();
  await w.api(mike, "POST budget", { subjectId: olivia.id, amount: "60", occasion: X });
  await join(w, alexis, olivia);
  assert.equal((await occ(w, mike, olivia)).budget_cents, 6000, "Mike still has his");
  assert.equal((await occ(w, alexis, olivia)).budget_cents, null, "it's not Alexis's");
});

test("other households' Christmas budget for someone adds into their new household's", async () => {
  const { w, alexis, maria, nolan, olivia } = family();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X });
  await w.api(alexis, "POST budget", { subjectId: olivia.id, amount: "30", occasion: X });
  await join(w, maria, olivia); // Olivia joins the Garcias
  assert.equal((await occ(w, alexis, olivia)).budget_cents, 23000);
  assert.equal((await occ(w, alexis, nolan)).budget_cents, 23000, "one budget for the whole household");
});

test("leaving a household you shop from starts you fresh; the household keeps its budgets", async () => {
  const { w, alexis, mike, maria } = family();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X });
  await w.api(mike, "POST household/remove", { memberId: mike.id });
  assert.equal((await occ(w, mike, maria)).budget_cents, null);
  assert.equal((await occ(w, alexis, maria)).budget_cents, 20000);
});

test("someone leaving a household you shop for: the budget stays with who's left", async () => {
  const { w, alexis, maria, nolan } = family();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X });
  await w.api(nolan, "POST household/remove", { memberId: nolan.id });
  assert.equal((await occ(w, alexis, maria)).budget_cents, 20000);
  assert.equal((await occ(w, alexis, nolan)).budget_cents, null);
});

test("when the last one leaves a household you shop for, its Christmas budget becomes theirs", async () => {
  const { w, alexis, maria, nolan } = family();
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "200", occasion: X });
  await w.api(nolan, "POST household/remove", { memberId: nolan.id });
  await w.api(maria, "POST household/remove", { memberId: maria.id });
  assert.equal((await occ(w, alexis, maria)).budget_cents, 20000);
});

test("birthday budgets stay with the person through household changes", async () => {
  const { w, alexis, maria, nolan } = family();
  const bday = (await occ(w, alexis, maria, null)) || null;
  const t = await w.api(alexis, "GET tracker");
  const code = t.people.find((p) => p.id === maria.id).occasions.find((o) => o.birthday).code;
  await w.api(alexis, "POST budget", { subjectId: maria.id, amount: "75", occasion: code });
  await w.api(nolan, "POST household/remove", { memberId: nolan.id });
  await w.api(maria, "POST household/remove", { memberId: maria.id });
  assert.equal((await occ(w, alexis, maria, code)).budget_cents, 7500);
  void bday;
});

test("not doing gifts with a household still holds for someone who moves out of it", async () => {
  const { w, alexis, maria, nolan, garcias } = family();
  await w.api(alexis, "POST budget/skip", { target: `h:${garcias}`, skip: true });
  await w.api(nolan, "POST household/remove", { memberId: nolan.id });
  const t = await w.api(alexis, "GET tracker");
  assert.equal(t.people.find((p) => p.id === nolan.id).skipped, true);
  assert.equal(t.people.find((p) => p.id === maria.id).skipped, true);
});

test("repair migration: brings back budgets that were stored but not shown, without changing shown ones", async () => {
  const { readFileSync } = await import("node:fs");
  const repair = readFileSync(new URL("../migrations/0045_budget_repair.sql", import.meta.url), "utf8");
  const { w, alexis, mike, maria, nolan, olivia, freddy, garcias, davidsons } = family();
  // Shown today: the Davidsons' $200 for the Garcias.
  w.run("INSERT INTO household_budgets (household_id, target, season, amount_cents) VALUES (?, ?, ?, 20000)", davidsons, `h:${garcias}`, X);
  // Hidden: Mike's own $90 for Maria from before he was in a household (the household already has one: stays $200),
  // and his $40 for Freddy (no household one: comes back).
  w.run("INSERT INTO budgets (author_id, subject_id, season, amount_cents) VALUES (?, ?, ?, 9000), (?, ?, ?, 4000)", mike.id, maria.id, X, mike.id, freddy.id, X);
  // Hidden: the Davidsons' $30 for Olivia on her own, before she joined the Garcias.
  w.run("INSERT INTO household_budgets (household_id, target, season, amount_cents) VALUES (?, ?, ?, 3000)", davidsons, `m:${olivia.id}`, X);
  w.run("UPDATE members SET household_id = ? WHERE id = ?", garcias, olivia.id);
  // A third household with only a hidden budget for one of them.
  const h3 = w.household([freddy]);
  w.db.exec(repair);
  assert.equal((await occ(w, alexis, maria)).budget_cents, 20000, "shown budget unchanged");
  assert.equal((await occ(w, alexis, freddy)).budget_cents, 4000, "hidden budget for Freddy's household back");
  void nolan; void h3;
});
