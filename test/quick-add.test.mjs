// Quick add: tapping Add before the link lookup finishes saves right away (named from the link's words), and the
// background refresh fills in the photo, price and the store's real name. A name someone typed is never replaced.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { world, SHOP } from "./worker-harness.mjs";

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.close())));

async function setup() {
  const w = await world();
  worlds.push(w);
  const A = await w.start("Alexis", "1111", "Fam");
  return { w, A };
}
const mine = async (A, id) => (await A.api("list")).items.find((i) => i.id === id);
async function refreshAll(A) {
  for (let i = 0; i < 10; i++) if (!(await A.api("refresh", {})).remaining) break;
}

test("a wish saved with a guessed name gets the store's name, photo and price", async () => {
  const { A } = await setup();
  const { id } = await A.api("item/save", { title: "Cozy blanket guess", url: `${SHOP}Cozy-Throw-Blanket`, unfilled: true, nameGuess: true });
  await A.api("item/publish", { id });
  let item = await mine(A, id);
  assert.equal(item.title, "Cozy blanket guess");
  await refreshAll(A);
  item = await mine(A, id);
  assert.equal(item.title, "Cozy-Throw-Blanket");
  assert.equal(item.price_cents, 1999);
  assert.ok(item.image_url);
});

test("a name the person typed stays, even when the lookup hadn't finished", async () => {
  const { A } = await setup();
  const { id } = await A.api("item/save", { title: "Grandma's blanket", url: `${SHOP}Cozy-Throw-Blanket`, unfilled: true });
  await refreshAll(A);
  const item = await mine(A, id);
  assert.equal(item.title, "Grandma's blanket");
  assert.equal(item.price_cents, 1999);
});

test("renaming a guessed wish before the refresh keeps the new name", async () => {
  const { A } = await setup();
  const url = `${SHOP}Cozy-Throw-Blanket`;
  const { id } = await A.api("item/save", { title: "Cozy blanket guess", url, unfilled: true, nameGuess: true });
  await A.api("item/save", { id, title: "The soft one", url, category: null });
  await refreshAll(A);
  assert.equal((await mine(A, id)).title, "The soft one");
});

test("a gift idea saved with a guessed name gets the store's name too", async () => {
  const { w, A } = await setup();
  const me = await A.api("me");
  const code = me.groups[0].code;
  const M = await w.join(code, "Mike", "2222");
  const mike = (await M.api("me")).me.id;
  const { id } = await A.api("idea/save", { subjectId: mike, title: "Some guess", url: `${SHOP}Fancy-Mug`, unfilled: true, nameGuess: true });
  await refreshAll(A);
  const { ideas } = await A.api(`ideas?subject=${mike}`);
  const idea = ideas.find((i) => i.id === id);
  assert.ok(idea, "idea is listed");
  assert.equal(idea.title, "Fancy-Mug");
});
