// "I'll get this" tapped by two people at the same moment: only one of them gets the wish (src/wishlist.js POST claim).
import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./harness.mjs";

test("two people marking the same wish at once: only one gets it", async () => {
  const w = world();
  const c = w.circle();
  const mom = w.person("Mom", { circle: c });
  const ann = w.person("Ann", { circle: c });
  const bob = w.person("Bob", { circle: c });
  const item = w.item(mom, "Scarf");
  const [a, b] = await Promise.all([
    w.call(ann, "POST claim", { itemId: item, on: true }),
    w.call(bob, "POST claim", { itemId: item, on: true }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM claims WHERE item_id = ?", item)[0].n, 1);
});

test("a wish wanted 3 times: racing buyers can't take more than 3", async () => {
  const w = world();
  const c = w.circle();
  const mom = w.person("Mom", { circle: c });
  const buyers = ["Ann", "Bob", "Cal", "Dee"].map((n) => w.person(n, { circle: c }));
  const item = w.item(mom, "Socks");
  w.run("UPDATE items SET quantity = 3 WHERE id = ?", item);
  const res = await Promise.all(buyers.map((p) => w.call(p, "POST claim", { itemId: item, on: true, qty: 1 })));
  assert.equal(res.filter((r) => r.status === 200).length, 3);
  assert.equal(w.sql("SELECT SUM(qty) AS n FROM claims WHERE item_id = ?", item)[0].n, 3);
});

test("changing how many you're getting still respects what's left", async () => {
  const w = world();
  const c = w.circle();
  const mom = w.person("Mom", { circle: c });
  const ann = w.person("Ann", { circle: c });
  const bob = w.person("Bob", { circle: c });
  const item = w.item(mom, "Socks");
  w.run("UPDATE items SET quantity = 3 WHERE id = ?", item);
  await w.api(ann, "POST claim", { itemId: item, on: true, qty: 1 });
  const [up, other] = await Promise.all([
    w.call(ann, "POST claim", { itemId: item, on: true, qty: 2 }),
    w.call(bob, "POST claim", { itemId: item, on: true, qty: 2 }),
  ]);
  assert.equal([up, other].filter((r) => r.status === 200).length, 1);
  assert.ok(w.sql("SELECT SUM(qty) AS n FROM claims WHERE item_id = ?", item)[0].n <= 3);
});
