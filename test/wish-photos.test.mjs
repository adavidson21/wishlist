// Your own photo for a wish (Add a photo): it's the wish's picture over the store's, everyone who can see the wish
// sees it, a new link never replaces it, and Remove goes back to the store's photo.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { world, SHOP } from "./worker-harness.mjs";

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.close())));

// A tiny real JPEG (1x1), as a data URL like the app sends.
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z";

async function setup() {
  const w = await world();
  worlds.push(w);
  const A = await w.start("Alexis", "1111", "Fam");
  const code = (await A.api("me")).groups[0].code;
  const M = await w.join(code, "Mike", "2222");
  return { w, A, M };
}
const mine = async (A, id) => (await A.api("list")).items.find((i) => i.id === id);

test("a wish with no link can have your own photo, and the circle sees it", async () => {
  const { w, A, M } = await setup();
  const { id } = await A.api("item/save", { title: "Craft fair mug", photo: JPEG });
  await A.api("item/publish", { id });
  const item = await mine(A, id);
  assert.ok(item.own_photo);
  assert.match(item.image_url, new RegExp(`^/api/photo\\?i=${id}&v=`));
  const theirs = (await M.api(`list?member=${A.id}`)).items.find((i) => i.id === id);
  assert.equal(theirs.image_url, item.image_url);
  const img = await w.request(item.image_url);
  assert.equal(img.status, 200);
});

test("your photo wins over the store's, also when the link changes", async () => {
  const { A } = await setup();
  const { id } = await A.api("item/save", { title: "Throw", url: `${SHOP}Throw`, image: `${SHOP}Throw.png`, photo: JPEG });
  let item = await mine(A, id);
  assert.ok(item.own_photo);
  await A.api("item/save", { id, title: "Throw", url: `${SHOP}Other-Throw`, image: `${SHOP}Other-Throw.png` });
  item = await mine(A, id);
  assert.ok(item.own_photo, "a new link doesn't replace it");
  // The photo lookup leaves it alone too.
  const r = await A.api("image", { kind: "item", id });
  assert.equal(r.image, item.image_url);
});

test("a new photo gets a new address, and Remove goes back to the store's photo", async () => {
  const { w, A } = await setup();
  const { id } = await A.api("item/save", { title: "Throw", url: `${SHOP}Throw`, photo: JPEG });
  const first = (await mine(A, id)).image_url;
  await new Promise((r) => setTimeout(r, 5));
  await A.api("item/save", { id, title: "Throw", url: `${SHOP}Throw`, photo: JPEG });
  const second = (await mine(A, id)).image_url;
  assert.notEqual(first, second);
  await A.api("item/save", { id, title: "Throw", url: `${SHOP}Throw`, image: `${SHOP}Throw.png`, photo: null });
  const item = await mine(A, id);
  assert.ok(!item.own_photo);
  assert.equal(item.image_url, `${SHOP}Throw.png`);
  assert.equal((await w.request(second)).status, 404);
});

test("only a real photo is accepted, and only on your own wishes", async () => {
  const { A, M } = await setup();
  const bad = await A.raw("item/save", { title: "Mug", photo: "data:text/html;base64,PGgxPmhpPC9oMT4=" });
  assert.equal(bad.status, 400);
  const { id } = await A.api("item/save", { title: "Mug" });
  const other = await M.raw("item/save", { id, title: "Mine now", photo: JPEG });
  assert.equal(other.status, 404);
  assert.ok(!(await mine(A, id)).own_photo);
});

test("removing a wish takes its photo too", async () => {
  const { w, A } = await setup();
  const { id } = await A.api("item/save", { title: "Mug", photo: JPEG });
  const src = (await mine(A, id)).image_url;
  await A.api("item/remove", { id });
  assert.equal((await w.request(src)).status, 404);
  const n = await (await w.db()).prepare("SELECT COUNT(*) AS n FROM item_photos").first();
  assert.equal(n.n, 0);
});
