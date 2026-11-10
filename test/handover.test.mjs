// Surprises that started before someone was on Hints. Alexis sets up Gran's list (Gran doesn't use the app yet), and
// the circle marks Gran's wishes, chats about her and shares a suggestion. While Gran is looked after, her managers
// see those marks (there's nobody to surprise). The moment Gran takes her list over, by her personal link or by
// tapping her name on the circle link, she must see none of it.
// Plus: a phone handed from one person to another never shows the new person a notification meant for the old one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, SHOP } from "./worker-harness.mjs";

const SPOILER = "SPOILER";

async function setUp(w) {
  const A = await w.start("Alexis", "1111", "Fam");
  const me = await A.api("me");
  const group = me.groups[0].id, code = me.groups[0].code;
  const S = await w.join(code, "Sam", "3333");
  const gran = (await A.api("managed/add", { name: "Gran", groupIds: [group], joinHousehold: false })).id;
  const scarf = (await A.api("item/save", { as: gran, title: "Scarf", url: `${SHOP}scarf`, price: 30 })).id;
  await A.api("item/save", { as: gran, title: "Tea", url: `${SHOP}tea`, price: 12 });
  await S.api("claim", { itemId: scarf, on: true, price: 31 });
  await S.api("idea/save", { subjectId: gran, title: `${SPOILER} suggestion`, shared: true });
  await S.api("chat/send", { group, member: gran, body: `${SPOILER} I've got the scarf` });
  await A.api("giftcards/save", { as: gran, brands: ["starbucks"] });
  await S.api("giftcard/give", { memberId: gran, brand: "starbucks", amount: 20 });
  return { A, S, group, code, gran, scarf };
}

// Everything Gran can read once she's signed in.
async function granSees(w, G, group) {
  const out = {};
  for (const path of ["me", "list", `list?member=${G.id}`, "feed", "ideas", "tracker", "history", `chat?group=${group}&member=${G.id}`]) {
    out[path] = await G.raw(path);
  }
  return out;
}

function assertNoSpoilers(seen, granId, group) {
  for (const [path, r] of Object.entries(seen)) assert.ok(!JSON.stringify(r.data).includes(SPOILER), `${path} shows a secret`);
  assert.equal(seen[`chat?group=${group}&member=${granId}`].status, 404, "she can't open the chat about her");
  const list = seen.list.data;
  assert.ok(list.own, "her own list");
  assert.equal(list.items.length, 2);
  for (const item of list.items) {
    assert.equal(item.claim, undefined, `${item.title} carries a mark`);
    assert.equal(item.gift, undefined, `${item.title} carries gift info`);
    assert.equal(item.held, null);
  }
  assert.equal(list.suggestions, undefined);
  assert.equal(list.chatCounts, undefined);
  assert.deepEqual(list.giftCards, [{ brand: "starbucks" }], "her gift cards, never who's giving one");
  for (const g of seen.me.data.groups) for (const m of g.members) if (m.id === granId) assert.equal(m.chatUnread, 0, "unread badge on her own thread");
}

test("a list handed over by personal link keeps its surprises", async () => {
  const w = await world();
  try {
    const { A, S, group, gran, scarf } = await setUp(w);
    // While she's looked after, her manager sees the marks (nobody to surprise yet).
    const managed = await A.api(`list?member=${gran}`);
    assert.ok(managed.canManage);
    assert.ok(managed.items.find((i) => i.id === scarf).claim, "Alexis (her manager) sees Sam's mark");

    const { token } = await A.api("managed/invite", { memberId: gran });
    // Opening the link, before signing in: who it's for, never anything about gifts.
    const peek = await w.request("/api/claim/lookup", { body: { token } });
    assert.equal(peek.status, 200);
    assert.deepEqual(Object.keys(peek.data).sort(), ["by", "circles", "id", "name", "needPin", "pin", "returning", "wishes"]);
    assert.equal(peek.data.wishes, 2);

    const claimed = await w.request("/api/invite/claim", { body: { token, pin: "5555" } });
    assert.equal(claimed.status, 200);
    const G = { id: gran, raw: (path, body) => w.request(`/api/${path}`, { token: claimed.data.token, body }) };
    assertNoSpoilers(await granSees(w, G, group), gran, group);

    // And Alexis is no longer her manager: Gran's list is a normal list to her now.
    assert.ok(!(await A.api(`list?member=${gran}`)).canManage);
    // Gran's chat stays readable for everyone else.
    assert.ok((await S.api(`chat?group=${group}&member=${gran}`)).messages.length);
  } finally {
    await w.close();
  }
});

test("a list handed over by tapping your name on the circle link (circles from before 0049) keeps its surprises", async () => {
  const w = await world();
  try {
    const { group, code, gran } = await setUp(w);
    // Circles started after public sign-ups opened don't hand a set-up list over from the circle link (migration
    // 0049): the admin sends a personal link instead. Circles from before that still do, which is what this covers.
    const refused = await w.request("/api/join", { body: { code, memberId: gran, pin: "5555" } });
    assert.equal(refused.status, 403, "a new circle refuses");
    await (await w.db()).prepare("UPDATE groups SET link_claims = 1 WHERE id = ?").bind(group).run();
    const names = await w.request("/api/lookup", { body: { code } });
    const row = names.data.members.find((m) => m.id === gran);
    assert.ok(row.waiting, "shows as Ready for you");
    assert.ok(!JSON.stringify(names.data).includes(SPOILER));
    const joined = await w.request("/api/join", { body: { code, memberId: gran, pin: "5555" } });
    assert.equal(joined.status, 200);
    assert.ok(joined.data.claimed);
    const G = { id: gran, raw: (path, body) => w.request(`/api/${path}`, { token: joined.data.token, body }) };
    assertNoSpoilers(await granSees(w, G, group), gran, group);
  } finally {
    await w.close();
  }
});

test("a phone passed from Mike to Alexis never shows her a notification about herself", async () => {
  const w = await world();
  try {
    const A = await w.start("Alexis", "1111", "Fam");
    const me = await A.api("me");
    const group = me.groups[0].id, code = me.groups[0].code;
    const M = await w.join(code, "Mike", "2222");
    const S = await w.join(code, "Sam", "3333");
    await M.api("push/prefs", { chatText: true });
    const phone = await M.subscribe(); // Mike turns notifications on, on the shared phone
    await S.api("chat/send", { group, member: A.id, body: "warm-up" });
    assert.equal(w.pushes.filter((p) => p.endpoint === phone).length, 1, "Mike's phone gets chat notifications while he's signed in");
    await M.api(`chat?group=${group}&member=${A.id}`); // he reads it, so the next message would notify him again
    await M.api("signout", {});
    // Alexis signs in on the same phone (and doesn't turn notifications on).
    const again = await w.request("/api/join", { body: { code, memberId: A.id, pin: "1111" } });
    assert.equal(again.status, 200);
    await S.api("chat/send", { group, member: A.id, body: `${SPOILER} the necklace is wrapped` });
    await w.cron();
    assert.equal(w.pushes.filter((p) => p.endpoint === phone).length, 1, "nothing more reached the shared phone");
  } finally {
    await w.close();
  }
});
