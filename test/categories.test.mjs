// Category guess (guessCategories in src/wishlist.js): wishes the owner didn't put in a category get one from
// Gemini, from the name, brand and store only. The owner's own pick is never touched, and a rename clears the guess.
import test from "node:test";
import assert from "node:assert/strict";
import { world } from "./harness.mjs";
import { runSchedule } from "../src/wishlist.js";

// A pretend Gemini that sorts by a lookup table and records what was sent.
function fakeGemini(table) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const body = String(opts.body || "");
      sent.push(body);
      const input = JSON.parse(JSON.parse(body).contents[0].parts[0].text);
      const items = input.items.map((x) => ({ id: x.id, category: table[x.name] || "other" }));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items }) }] } }] }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

test("Categories: unsorted wishes get Gemini's guess, the owner's pick stays, only gift details are sent", async () => {
  const w = world();
  w.env.GEMINI_API_KEY = "test";
  const alexis = w.person("Alexis", { circle: w.circle(), lastName: "Zephyrine" });
  const a = w.item(alexis, "Quince cashmere crewneck");
  const b = w.item(alexis, "Bluey Heeler house");
  const picked = w.item(alexis, "Mystery thing");
  w.run("UPDATE items SET category = 'books' WHERE id = ?", picked);
  w.run("UPDATE items SET notes = 'for the cabin trip' WHERE id = ?", a);
  const g = fakeGemini({ "Quince cashmere crewneck": "clothing", "Bluey Heeler house": "toys", "Mystery thing": "tech" });
  try {
    await runSchedule(w.env);
  const cat = (id) => w.sql("SELECT category, category_auto FROM items WHERE id = ?", id)[0];
  assert.equal(cat(a).category_auto, "clothing");
  assert.equal(cat(b).category_auto, "toys");
  assert.deepEqual(cat(picked), { category: "books", category_auto: null });
  assert.equal(g.sent.length, 1, "one call for the batch");
  assert.ok(!/Mystery thing/.test(g.sent[0]), "picked wishes aren't sent");
  assert.ok(!/Alexis|Zephyrine|cabin/.test(g.sent[0]), "nothing about the person or their notes");

  // It's on the wish for the app, and a rename clears it for a fresh guess.
  const list = await w.api(alexis, "GET list", { member: alexis.id });
  assert.equal(list.items.find((i) => i.id === a)?.category_auto, "clothing");
  w.env.GEMINI_API_KEY = ""; // no background guess after the saves below, so the reset is what's checked
  await w.api(alexis, "POST item/save", { id: a, title: "Quince silk pillowcase" });
  assert.equal(cat(a).category_auto, null);
  await w.api(alexis, "POST item/save", { id: b, title: "Bluey Heeler house" });
  assert.equal(cat(b).category_auto, "toys", "same name keeps its guess");
  } finally { g.restore(); }
});
