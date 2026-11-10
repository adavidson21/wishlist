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
