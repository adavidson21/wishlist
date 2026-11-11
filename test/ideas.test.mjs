// "Ideas for you" (POST recommend, POST ideas/pref): on by default, can be turned off, and only the names, brands
// and categories of your own wishes ever reach Gemini (the privacy page promises that).
import test from "node:test";
import assert from "node:assert/strict";
import { world } from "./harness.mjs";

// A pretend Gemini: records what was sent and answers with `suggestions`. Store pages answer 404, so every idea
// falls back to a store search link.
function fakeGemini(suggestions) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      sent.push(String(opts.body || ""));
      const text = JSON.stringify({ suggestions });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("nope", { status: 404 });
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

const idea = (title, extra = {}) => ({ title, detail: "Goes with your mug", search: title, price_low: 10, price_high: 20, brand_domain: "", links: [], store: "target", ...extra });

test("Ideas: on by default, off in Settings blocks it, back on works", async () => {
  const w = world();
  w.env.GEMINI_API_KEY = "test";
  const c = w.circle();
  const alexis = w.person("Alexis", { circle: c });
  w.item(alexis, "Stanley Quencher tumbler");
  w.item(alexis, "Lego Botanicals orchid");
  assert.equal((await w.api(alexis, "GET me")).me.ideasOff, false);

  await w.api(alexis, "POST ideas/pref", { on: false });
  assert.equal((await w.api(alexis, "GET me")).me.ideasOff, true);
  const g = fakeGemini([idea("Stanley straw lids")]);
  try {
    assert.equal((await w.call(alexis, "POST recommend", {})).status, 403);
    assert.equal(g.sent.length, 0, "no Gemini call while it's off");
    await w.api(alexis, "POST ideas/pref", { on: true });
    const r = await w.api(alexis, "POST recommend", {});
    assert.equal(r.suggestions.length, 1);
    assert.equal(r.suggestions[0].link, "search");
  } finally { g.restore(); }
});

test("Ideas: needs a couple of wishes first", async () => {
  const w = world();
  w.env.GEMINI_API_KEY = "test";
  const alexis = w.person("Alexis", { circle: w.circle() });
  w.item(alexis, "Cozy socks");
  const g = fakeGemini([idea("Slippers")]);
  try {
    assert.equal((await w.call(alexis, "POST recommend", {})).status, 400);
    assert.equal(g.sent.length, 0);
  } finally { g.restore(); }
});

test("Ideas: only your own wish names and brands reach Gemini, never who you are or your profile", async () => {
  const w = world();
  w.env.GEMINI_API_KEY = "test";
  const c = w.circle();
  const alexis = w.person("Alexis", { circle: c, lastName: "Zephyrine" });
  const mike = w.person("Mike", { circle: c });
  const a = w.item(alexis, "Stanley Quencher tumbler");
  w.item(alexis, "Lego Botanicals orchid");
  w.run("UPDATE items SET notes = 'size small, for the cabin trip', brand = 'Stanley' WHERE id = ?", a);
  w.run("UPDATE members SET likes = '[\"Pickleball\"]', dislikes = '[\"Orange\"]', avoid = 'Peanut allergy', birthday = '03-14' WHERE id = ?", alexis.id);
  w.item(mike, "Secret fishing reel");
  const g = fakeGemini([idea("Stanley straw lids"), idea("stanley quencher TUMBLER"), idea("Lego Bonsai Tree"), idea("Already shown"), idea("Mug warmer")]);
  try {
    const r = await w.api(alexis, "POST recommend", { avoid: ["Already shown"] });
    const body = g.sent.join(" ");
    assert.match(body, /Stanley Quencher tumbler/);
    assert.match(body, /Stanley/);
    for (const secret of ["Alexis", "Zephyrine", "cabin trip", "Pickleball", "Orange", "Peanut", "03-14", "Secret fishing reel", alexis.id]) {
      assert.ok(!body.includes(secret), `"${secret}" must not be sent to Gemini`);
    }
    // Nothing already on the list (any spelling) or already shown.
    assert.deepEqual(r.suggestions.map((x) => x.title), ["Stanley straw lids", "Lego Bonsai Tree", "Mug warmer"]);
    assert.ok(r.suggestions.every((x) => x.url.startsWith("https://")));
  } finally { g.restore(); }
});
