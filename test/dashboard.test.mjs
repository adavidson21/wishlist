// The owner's dashboard (public/admin.html): owner only, unlocked with their PIN, read-only, and it never spoils
// the owner's own surprises (no marks on their own list) or shows what's in anyone else's Maybe.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { world } from "./worker-harness.mjs";

const worlds = [];
after(() => Promise.all(worlds.map((w) => w.close())));

async function setup() {
  const w = await world();
  worlds.push(w);
  const A = await w.start("Alexis", "1111", "Fam"); // first to join: runs Hints
  const code = (await A.api("me")).groups[0].code;
  const M = await w.join(code, "Mike", "2222");
  const S = await w.join(code, "Sam", "3333");
  const wish = async (P, title, publish = true) => {
    const { id } = await P.api("item/save", { title, price: 20 });
    if (publish) await P.api("item/publish", { id });
    return id;
  };
  return { w, A, M, S, wish };
}

test("only the owner can open it, and only after their PIN", async () => {
  const { A, M } = await setup();
  assert.equal((await M.raw("owner/unlock", { pin: "2222" })).status, 404);
  assert.equal((await M.raw("owner/dashboard")).status, 404);
  const locked = await A.raw("owner/dashboard");
  assert.equal(locked.status, 403);
  assert.equal(locked.data.locked, true);
  assert.equal((await A.raw("owner/unlock", { pin: "9999" })).status, 403);
  assert.equal((await A.raw("owner/dashboard")).status, 403, "a wrong PIN unlocks nothing");
  await A.api("owner/unlock", { pin: "1111" });
  const d = await A.api("owner/dashboard");
  assert.deepEqual(d.people.map((p) => p.name).sort(), ["Alexis", "Mike", "Sam"]);
  await A.api("owner/lock", {});
  assert.equal((await A.raw("owner/dashboard")).status, 403, "Lock closes it again");
});

test("the owner's own list never shows marks", async () => {
  const { A, M, wish } = await setup();
  const mine = await wish(A, "Record player");
  const gone = await wish(A, "Old headphones");
  await M.api("claim", { itemId: mine, on: true });
  await M.api("claim", { itemId: gone, on: true });
  await A.api("item/remove", { id: gone }); // kept for Mike, since he marked it
  await A.api("owner/unlock", { pin: "1111" });
  const me = (await A.api("owner/dashboard")).people.find((p) => p.you);
  assert.equal(me.taken, null);
  assert.equal(me.wishes, 1, "a removed wish someone marked doesn't count, so the count can't hint at it");
  const list = await A.api(`owner/person?member=${A.id}`);
  assert.equal(list.marksShown, false);
  assert.deepEqual(list.wishes.map((i) => i.title), ["Record player"]);
  assert.ok(!("taken" in list.wishes[0]));
  assert.ok(!JSON.stringify(list).includes("Mike"));
});

test("other lists show taken counts but no buyers, and Maybe only as a count", async () => {
  const { A, M, S, wish } = await setup();
  const blanket = await wish(M, "Blanket");
  await wish(M, "Secret draft idea", false);
  await S.api("claim", { itemId: blanket, on: true });
  await A.api("owner/unlock", { pin: "1111" });
  const mike = (await A.api("owner/dashboard")).people.find((p) => p.name === "Mike");
  assert.equal(mike.taken, 1);
  assert.equal(mike.maybes, 1);
  const list = await A.api(`owner/person?member=${M.id}`);
  assert.equal(list.wishes[0].taken.qty, 1);
  assert.equal(list.maybeCount, 1);
  assert.equal(list.maybes, null);
  const raw = JSON.stringify(list);
  assert.ok(!raw.includes("Secret draft idea"), "Maybe titles stay private");
  assert.ok(!raw.includes("Sam"), "never who bought it");
});

test("no marks for people the owner shares no circle with", async () => {
  const { w, A, wish } = await setup();
  const Z = await w.start("Zoe", "4444", "Elsewhere");
  const code = (await Z.api("me")).groups[0].code;
  const Y = await w.join(code, "Yan", "5555");
  const id = await wish(Z, "Kayak");
  await Y.api("claim", { itemId: id, on: true });
  await A.api("owner/unlock", { pin: "1111" });
  assert.equal((await A.api("owner/dashboard")).people.find((p) => p.name === "Zoe").taken, null);
  const list = await A.api(`owner/person?member=${Z.id}`);
  assert.equal(list.marksShown, false);
  assert.ok(!("taken" in list.wishes[0]));
});
