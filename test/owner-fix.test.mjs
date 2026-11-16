// Whoever runs Hints can tidy up a wish on anyone's list in a circle they share (name, photo, link, details),
// without seeing anything new: no marks, and no adding, removing, Top pick or how many. Nobody else can.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { world, SHOP } from "./worker-harness.mjs";

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.close())));

async function setup() {
  const w = await world();
  worlds.push(w);
  const A = await w.start("Alexis", "1111", "Fam"); // first to join: runs Hints
  const code = (await A.api("me")).groups[0].code;
  const M = await w.join(code, "Mike", "2222");
  const S = await w.join(code, "Sam", "3333");
  const { id } = await M.api("item/save", { title: "amzn blnkt thing", url: `${SHOP}Blanket`, price: 40 });
  await M.api("item/publish", { id });
  await M.api("item/save", { id, title: "amzn blnkt thing", url: `${SHOP}Blanket`, price: 40, priority: "must", quantity: 2 });
  return { w, A, M, S, id };
}
const theirs = async (M, id) => (await M.api("list")).items.find((i) => i.id === id);

test("whoever runs Hints can fix the name and details of someone's wish", async () => {
  const { A, M, id } = await setup();
  await A.api("item/save", { id, as: M.id, fix: true, title: "Cozy throw blanket", url: `${SHOP}Blanket`, price: 45, brand: "Barefoot", category: null, priority: null, quantity: 1 });
  const item = await theirs(M, id);
  assert.equal(item.title, "Cozy throw blanket");
  assert.equal(item.brand, "Barefoot");
  assert.equal(item.price_cents, 4500);
  assert.equal(item.priority, "must", "Top pick stays the person's call");
  assert.equal(item.quantity, 2, "how many stays the person's call");
  // Still theirs to change back.
  await M.api("item/save", { id, title: "My blanket", url: `${SHOP}Blanket`, price: 45 });
  assert.equal((await theirs(M, id)).title, "My blanket");
});

test("fixing never shows marks, and can't add or remove wishes", async () => {
  const { A, M, S, id } = await setup();
  await S.api("claim", { itemId: id, on: true });
  const seen = (await A.api(`list?member=${M.id}`)).items.find((i) => i.id === id);
  await A.api("item/save", { id, as: M.id, fix: true, title: "Cozy throw blanket", url: `${SHOP}Blanket`, price: 40 });
  const after = (await A.api(`list?member=${M.id}`)).items.find((i) => i.id === id);
  assert.deepEqual({ ...after, title: seen.title, updated_at: seen.updated_at }, seen, "nothing new comes back besides the edit");
  await assert.rejects(A.api("item/save", { as: M.id, fix: true, title: "New thing" }));
  await assert.rejects(A.api("item/remove", { id, as: M.id }));
  assert.ok(await theirs(M, id));
});

test("nobody else can fix someone's wish", async () => {
  const { M, S, id } = await setup();
  await assert.rejects(S.api("item/save", { id, as: M.id, fix: true, title: "Hacked" }));
  assert.equal((await theirs(M, id)).title, "amzn blnkt thing");
});
