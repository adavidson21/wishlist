// Pets (migrations 0037 and 0048): a birthday and favorites, just for fun. Never an occasion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./harness.mjs";

function setup() {
  const w = world();
  const c = w.circle("Family");
  const alexis = w.person("Alexis", { circle: c });
  const mike = w.person("Mike", { circle: c });
  const olivia = w.person("Olivia", { circle: c });
  const hh = w.household([alexis, mike]);
  return { w, alexis, mike, olivia, hh };
}

test("a pet keeps a birthday and favorites, and the circle sees them", async () => {
  const { w, alexis, olivia, hh } = setup();
  const { pet } = await w.api(alexis, "POST pet/save", { householdId: hh, name: "Biscuit", kind: "dog", birthday: "03-14", favorites: "Squeaky ducks, peanut butter" });
  const seen = (await w.api(olivia, "GET me")).pets[`h:${hh}`];
  assert.equal(seen.length, 1);
  assert.equal(seen[0].birthday, "03-14");
  assert.equal(seen[0].favorites, "Squeaky ducks, peanut butter");
  // Changing only the notes leaves the birthday and favorites alone; "" clears them.
  await w.api(alexis, "POST pet/save", { id: pet.id, notes: "Size L harness" });
  let p = (await w.api(alexis, "GET me")).pets[`h:${hh}`][0];
  assert.equal(p.birthday, "03-14");
  assert.equal(p.favorites, "Squeaky ducks, peanut butter");
  await w.api(alexis, "POST pet/save", { id: pet.id, birthday: "", favorites: "" });
  p = (await w.api(alexis, "GET me")).pets[`h:${hh}`][0];
  assert.equal(p.birthday, null);
  assert.equal(p.favorites, null);
});

test("a bad pet birthday or a too-long favorites line is refused", async () => {
  const { w, alexis, hh } = setup();
  await assert.rejects(w.api(alexis, "POST pet/save", { householdId: hh, name: "Max", kind: "cat", birthday: "02-30" }));
  await assert.rejects(w.api(alexis, "POST pet/save", { householdId: hh, name: "Max", kind: "cat", favorites: "x".repeat(121) }));
});

test("only the household can change its pets", async () => {
  const { w, alexis, olivia, hh } = setup();
  const { pet } = await w.api(alexis, "POST pet/save", { householdId: hh, name: "Biscuit", kind: "dog" });
  await assert.rejects(w.api(olivia, "POST pet/save", { id: pet.id, birthday: "01-01" }));
});

// People who aren't in a household keep pets on their own profile (key "m:<id>").
test("someone not in a household can add their own pet, and their circle sees it", async () => {
  const { w, alexis, olivia } = setup();
  const { pet } = await w.api(olivia, "POST pet/save", { name: "Mochi", kind: "cat", birthday: "06-01", favorites: "Boxes" });
  assert.equal((await w.api(olivia, "GET me")).pets[`m:${olivia.id}`][0].id, pet.id);
  const seen = (await w.api(alexis, "GET me")).pets[`m:${olivia.id}`];
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, "Mochi");
  // She can edit and remove it; others can't.
  await w.api(olivia, "POST pet/save", { id: pet.id, notes: "Loves crinkle toys" });
  await assert.rejects(w.api(alexis, "POST pet/save", { id: pet.id, notes: "nope" }));
  await assert.rejects(w.api(alexis, "POST pet/delete", { id: pet.id }));
  await w.api(olivia, "POST pet/delete", { id: pet.id });
  assert.equal((await w.api(olivia, "GET me")).pets[`m:${olivia.id}`], undefined);
});

test("someone with no circle and no household can still add a pet", async () => {
  const w = world();
  const solo = w.person("Sam");
  await w.api(solo, "POST pet/save", { name: "Rex", kind: "dog" });
  assert.equal((await w.api(solo, "GET me")).pets[`m:${solo.id}`][0].name, "Rex");
});

test("whoever looks after someone not in a household can add their pet", async () => {
  const { w, olivia, alexis, mike } = setup();
  const kid = w.person("Lily", { circle: w.sql("SELECT group_id FROM group_members WHERE member_id = ?", olivia.id)[0].group_id, managedBy: olivia });
  await w.api(olivia, "POST pet/save", { as: kid.id, name: "Goldie", kind: "fish" });
  assert.equal((await w.api(alexis, "GET me")).pets[`m:${kid.id}`][0].name, "Goldie");
  // Mike isn't in her household or the circle admin, so it isn't his to change.
  await assert.rejects(w.api(mike, "POST pet/save", { as: kid.id, name: "Nope", kind: "dog" }));
});
