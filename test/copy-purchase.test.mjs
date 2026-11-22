// "Got one for someone else too" (POST purchase/copy): the same gift, recorded for more people.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, xmasCode } from "./harness.mjs";

const X = xmasCode();
const occ = async (w, who, subject, code = X) =>
  (await w.api(who, "GET tracker")).people.find((p) => p.id === subject.id)?.occasions.find((o) => o.code === code);

function family() {
  const w = world();
  const c = w.circle("Family");
  const alexis = w.person("Alexis", { circle: c });
  const ava = w.person("Ava", { circle: c });
  const ben = w.person("Ben", { circle: c });
  const cora = w.person("Cora", { circle: c });
  const stranger = w.person("Stranger", { circle: w.circle("Other") });
  return { w, alexis, ava, ben, cora, stranger };
}

test("a wish you bought copies to others as your purchase, with the same price, progress and hiding spot", async () => {
  const { w, alexis, ava, ben, cora } = family();
  const pj = w.item(ava, "Matching pajamas", 3000);
  w.buy(alexis, pj, X, 2500);
  await w.api(alexis, "POST purchase/progress", { kind: "item", id: pj, occasion: X, status: "wrapped", stash: "Hall closet" });
  const r = await w.api(alexis, "POST purchase/copy", { kind: "item", id: pj, occasion: X, toIds: [ben.id, cora.id] });
  assert.equal(r.copies.length, 2);
  for (const who of [ben, cora]) {
    const o = await occ(w, alexis, who);
    assert.equal(o.purchases.length, 1);
    const x = o.purchases[0];
    assert.equal(x.title, "Matching pajamas");
    assert.equal(x.kind, "idea");
    assert.equal(x.spent_cents, 2500);
    assert.equal(x.status, "wrapped");
    assert.equal(x.stash, "Hall closet");
    assert.equal(x.from, "My idea");
  }
  // The original is untouched.
  assert.equal((await occ(w, alexis, ava)).purchases.length, 1);
});

test("the people it's copied to never see it, and the copies stay private ideas", async () => {
  const { w, alexis, ava, ben } = family();
  const pj = w.item(ava, "Matching pajamas", 3000);
  w.buy(alexis, pj);
  await w.api(alexis, "POST purchase/copy", { kind: "item", id: pj, occasion: X, toIds: [ben.id] });
  assert.deepEqual(w.sql("SELECT shared FROM private_ideas WHERE subject_id = ?", ben.id), [{ shared: 0 }]);
  const seen = JSON.stringify([
    await w.api(ben, "GET tracker"), await w.api(ben, "GET ideas"), await w.api(ben, "GET list", { member: ben.id }),
    await w.api(ben, "GET history"),
  ]);
  assert.ok(!seen.includes("Matching pajamas"), "Ben can't see the gift copied to him");
});

test("an idea and a gift card copy too", async () => {
  const { w, alexis, ava, ben } = family();
  const { id } = await w.api(alexis, "POST idea/save", { subjectId: ava.id, title: "Puzzle", price: 20, bought: true, paid: 18 });
  await w.api(alexis, "POST purchase/copy", { kind: "idea", id, occasion: X, toIds: [ben.id] });
  assert.equal((await occ(w, alexis, ben)).purchases[0].spent_cents, 1800);

  w.run("INSERT INTO gift_cards (member_id, brand, created_at) VALUES (?, 'starbucks', ?)", ava.id, new Date().toISOString());
  await w.api(alexis, "POST giftcard/give", { memberId: ava.id, brand: "starbucks", on: true, amount: 25, occasion: X });
  await w.api(alexis, "POST purchase/copy", { kind: "giftcard", id: "starbucks", subjectId: ava.id, occasion: X, toIds: [ben.id] });
  const cards = (await occ(w, alexis, ben)).purchases.filter((x) => x.kind === "giftcard");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].spent_cents, 2500);
});

test("a birthday gift goes under each person's next occasion", async () => {
  const w = world();
  const c = w.circle();
  const soon = new Date(Date.now() + 10 * 864e5);
  const mmdd = `${String(soon.getUTCMonth() + 1).padStart(2, "0")}-${String(soon.getUTCDate()).padStart(2, "0")}`;
  const alexis = w.person("Alexis", { circle: c });
  const ava = w.person("Ava", { circle: c, birthday: mmdd });
  const ben = w.person("Ben", { circle: c });
  const bday = (await w.api(alexis, "GET tracker")).people.find((p) => p.id === ava.id).occasions.find((o) => o.birthday && !o.christmas);
  if (!bday || bday.code > X) return; // her birthday lands after Christmas this time of year; nothing to show
  const item = w.item(ava, "Book");
  w.buy(alexis, item, bday.code);
  const r = await w.api(alexis, "POST purchase/copy", { kind: "item", id: item, occasion: bday.code, toIds: [ben.id] });
  assert.equal(r.copies[0].occasion, X, "Ben has no birthday, so his next occasion is Christmas");
});

test("only your own purchases, only people in your circles, never yourself", async () => {
  const { w, alexis, ava, ben, cora, stranger } = family();
  const pj = w.item(ava, "Matching pajamas");
  w.buy(ben, pj);
  // Ben's purchase: Alexis gets the same answer as for something nobody bought.
  const theirs = await w.call(alexis, "POST purchase/copy", { kind: "item", id: pj, occasion: X, toIds: [cora.id] });
  const nobody = await w.call(alexis, "POST purchase/copy", { kind: "item", id: w.item(ava, "Hat"), occasion: X, toIds: [cora.id] });
  assert.equal(theirs.status, 404);
  assert.deepEqual(theirs, nobody);

  const mine = w.item(ava, "Scarf");
  w.buy(alexis, mine);
  assert.equal((await w.call(alexis, "POST purchase/copy", { kind: "item", id: mine, occasion: X, toIds: [stranger.id] })).status, 400);
  assert.equal((await w.call(alexis, "POST purchase/copy", { kind: "item", id: mine, occasion: X, toIds: [alexis.id] })).status, 400);
  assert.equal((await w.call(alexis, "POST purchase/copy", { kind: "item", id: mine, occasion: X, toIds: [ava.id] })).status, 400, "not to the person it's already for");
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM private_ideas")[0].n, 0, "nothing was added");
});
