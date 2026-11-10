// Household requests (migration 0044): joining a household shares budgets and purchases, so app users say yes first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, xmasCode } from "./harness.mjs";

const X = xmasCode();
const hhOf = (w, p) => w.sql("SELECT household_id AS h FROM members WHERE id = ?", p.id)[0].h;

function setup() {
  const w = world();
  const c = w.circle("Family");
  const alexis = w.person("Alexis", { circle: c }); // admin
  const mike = w.person("Mike", { circle: c });
  const olivia = w.person("Olivia", { circle: c });
  const maria = w.person("Maria", { circle: c });
  const nolan = w.person("Nolan", { circle: c });
  const davidsons = w.household([alexis, mike]);
  const garcias = w.household([maria, nolan]);
  return { w, c, alexis, mike, olivia, maria, nolan, davidsons, garcias };
}

test("adding someone who uses the app asks them first, and they only join when they say yes", async () => {
  const { w, alexis, olivia, davidsons } = setup();
  const r = await w.api(alexis, "POST household/add", { memberId: olivia.id });
  assert.equal(r.asked, true);
  assert.equal(hhOf(w, olivia), null, "not in the household yet");
  const me = await w.api(olivia, "GET me");
  assert.equal(me.me.householdInvites.length, 1);
  assert.equal(me.me.householdInvites[0].by, "Alexis");
  const mine = await w.api(alexis, "GET me");
  assert.deepEqual(mine.me.householdAsks.map((a) => a.name), ["Olivia"]);
  await w.api(olivia, "POST household/answer", { id: me.me.householdInvites[0].id, accept: true });
  assert.equal(hhOf(w, olivia), davidsons);
  assert.equal((await w.api(olivia, "GET me")).me.householdInvites.length, 0);
});

test("saying no leaves everything as it was", async () => {
  const { w, alexis, olivia } = setup();
  await w.api(alexis, "POST household/add", { memberId: olivia.id });
  const id = (await w.api(olivia, "GET me")).me.householdInvites[0].id;
  await w.api(olivia, "POST household/answer", { id, accept: false });
  assert.equal(hhOf(w, olivia), null);
  assert.equal((await w.api(alexis, "GET me")).me.householdAsks.length, 0);
});

test("whoever asked can take it back", async () => {
  const { w, alexis, olivia } = setup();
  await w.api(alexis, "POST household/add", { memberId: olivia.id });
  const ask = (await w.api(alexis, "GET me")).me.householdAsks[0];
  await w.api(alexis, "POST household/uninvite", { id: ask.id });
  assert.equal((await w.api(olivia, "GET me")).me.householdInvites.length, 0);
});

test("someone with no household asking starts one together when they say yes", async () => {
  const w = world();
  const c = w.circle();
  const sam = w.person("Sam", { circle: c });
  const jo = w.person("Jo", { circle: c });
  await w.api(sam, "POST household/add", { memberId: jo.id });
  assert.equal(hhOf(w, sam), null, "Sam isn't put in a household of one while waiting");
  const id = (await w.api(jo, "GET me")).me.householdInvites[0].id;
  await w.api(jo, "POST household/answer", { id, accept: true });
  assert.ok(hhOf(w, sam));
  assert.equal(hhOf(w, sam), hhOf(w, jo));
});

test("people who don't use the app are still added straight away", async () => {
  const { w, c, alexis } = setup();
  const baby = w.person("Baby", { circle: c, managedBy: alexis });
  const r = await w.api(alexis, "POST household/add", { memberId: baby.id });
  assert.ok(!r.asked);
  assert.equal(hhOf(w, baby), hhOf(w, alexis));
});

test("a circle admin can't move themselves into someone else's household", async () => {
  const { w, alexis, garcias } = setup();
  await w.api(alexis, "POST household/remove", { memberId: alexis.id });
  const r = await w.call(alexis, "POST household/add", { householdId: garcias, memberId: alexis.id });
  assert.equal(r.status, 403);
  assert.equal(hhOf(w, alexis), null);
});

test("a circle admin adding an app user to another household asks them too", async () => {
  const { w, alexis, olivia, garcias } = setup();
  const r = await w.api(alexis, "POST household/add", { householdId: garcias, memberId: olivia.id });
  assert.equal(r.asked, true);
  assert.equal(hhOf(w, olivia), null);
  const inv = (await w.api(olivia, "GET me")).me.householdInvites[0];
  assert.match(inv.label, /Maria/);
  await w.api(olivia, "POST household/answer", { id: inv.id, accept: true });
  assert.equal(hhOf(w, olivia), garcias);
});

test("an admin grouping people asks the app users and adds the rest", async () => {
  const w = world();
  const c = w.circle();
  const admin = w.person("Admin", { circle: c });
  const ann = w.person("Ann", { circle: c });
  const kid = w.person("Kid", { circle: c, managedBy: admin });
  const r = await w.api(admin, "POST household/create", { groupId: c, memberIds: [ann.id, kid.id] });
  assert.equal(r.asked, 1);
  assert.equal(hhOf(w, kid), r.household.id);
  assert.equal(hhOf(w, ann), null);
  const id = (await w.api(ann, "GET me")).me.householdInvites[0].id;
  await w.api(ann, "POST household/answer", { id, accept: true });
  assert.equal(hhOf(w, ann), r.household.id);
});

test("a household made only of people who say no goes away", async () => {
  const w = world();
  const c = w.circle();
  const admin = w.person("Admin", { circle: c });
  const ann = w.person("Ann", { circle: c });
  const r = await w.api(admin, "POST household/create", { groupId: c, memberIds: [ann.id] });
  const id = (await w.api(ann, "GET me")).me.householdInvites[0].id;
  await w.api(ann, "POST household/answer", { id, accept: false });
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM households WHERE id = ?", r.household.id)[0].n, 0);
});

test("households that already exist are untouched", async () => {
  const { w, alexis, mike, davidsons } = setup();
  assert.equal(hhOf(w, mike), davidsons);
  assert.equal((await w.api(mike, "GET me")).me.householdInvites.length, 0);
  assert.equal((await w.api(alexis, "GET me")).me.household.members.length, 2);
});

test("you can't accept while you're in another household", async () => {
  const { w, alexis, maria } = setup();
  w.run("UPDATE members SET household_id = NULL WHERE id = ?", maria.id); // pretend she left
  await w.api(alexis, "POST household/add", { memberId: maria.id });
  const id = (await w.api(maria, "GET me")).me.householdInvites[0].id;
  w.run("UPDATE members SET household_id = (SELECT household_id FROM members WHERE id = ?) WHERE id = ?", alexis.id, maria.id);
  w.run("UPDATE members SET household_id = NULL WHERE id = ?", maria.id);
  const g = w.household([maria]);
  const r = await w.call(maria, "POST household/answer", { id, accept: true });
  assert.equal(r.status, 409);
  assert.equal(hhOf(w, maria), g);
});
