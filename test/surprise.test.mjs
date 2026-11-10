// "Never spoil a surprise", tested end to end.
//
// Two identical worlds are built: the same circle, the same wishes, the same public activity (feed posts, comments,
// reactions). In the second one, everyone else also does every secret thing Hints supports about Alexis: marks her
// wishes, starts and joins a group gift, gives her a gift card, shares a suggestion and buys it, keeps a private idea,
// chats about her (overnight too, so notifications wait for morning), sets a budget, records where a gift is hidden
// and gives her a nickname. Then Alexis looks at everything she can reach: every screen's API, the feed, her share
// link, the circle's public name list, her phone's notifications (decrypted) and the badge counts on them, and a set
// of probes that try to learn something from error messages.
//
// What Alexis sees must be identical in both worlds. Anything that differs is a leak.
//
// Adding an API route? It must be listed in ROUTES at the bottom, either with what Alexis's probe is, or why it can't
// tell her anything. The last test fails until it is.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { world, normalizer, nyToday, christmas, daysBefore, ROOT, SHOP } from "./worker-harness.mjs";

const SPOILER = "SPOILER"; // every secret written by someone else contains this word
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

// Builds one world. spoiled: everyone else also does the secret things.
async function build(spoiled, worlds) {
  const w = await world();
  worlds.push(w); // closed in after(), even if building fails part way
  await w.cron(); // the first run only starts the new-wish digest's clock
  const A = await w.start("Alexis", "1111", "Fam");
  const me = await A.api("me");
  const group = me.groups[0].id, code = me.groups[0].code;
  const M = await w.join(code, "Mike", "2222");
  const S = await w.join(code, "Sam", "3333");
  const P = await w.join(code, "Pat", "4444");
  const friends = (await A.api("family/start", { groupName: "Friends" })).group; // a second circle, with just Sam
  await S.api("family/join", { code: friends.code });
  for (const x of [A, M, S, P]) await x.subscribe();
  // Chat notifications with the message itself in them, for Pat and (if anything ever reached her) Alexis.
  await P.api("push/prefs", { chatText: true });
  await A.api("push/prefs", { chatText: true });
  await A.api("profile", { birthday: nyToday(14).mmdd, bio: "Coffee and books", likes: ["coffee"] });
  await S.api("profile", { birthday: nyToday(2).mmdd });

  const wish = async (p, title, extra = {}) => {
    const { id } = await p.api("item/save", { title, url: `${SHOP}${title.toLowerCase()}`, price: 20, ...extra });
    await p.api("item/publish", { id });
    return id;
  };
  const ids = {};
  ids.sweater = await wish(A, "Sweater", { price: 40 });
  ids.mixer = await wish(A, "Mixer", { price: 300 });
  ids.books = await wish(A, "Books", { quantity: 2 });
  ids.lamp = await wish(A, "Lamp"); // marked (spoiled world), then removed
  ids.mug = await wish(A, "Mug"); // removed, never marked
  ids.shade = await wish(A, "Shade");
  await A.api("item/link", { id: ids.shade, kind: "needs", with: ids.lamp });
  ids.saucer = await wish(A, "Saucer");
  await A.api("item/link", { id: ids.saucer, kind: "needs", with: ids.mug });
  ids.pencils = await wish(A, "Pencils");
  ids.coloring = await wish(A, "Coloring");
  await A.api("item/link", { id: ids.pencils, kind: "together", with: ids.coloring });
  await A.api("giftcards/save", { brands: ["starbucks", "panera"] });
  await A.api("share/link", { on: true });
  await A.api("feed/post", { body: "Hi everyone" });
  await wish(S, "Scarf");
  await wish(M, "Drill");
  await wish(P, "Kite");
  // Public on purpose: the feed is seen by the person it's about.
  const aCard = (await P.api("feed")).cards.find((c) => c.actor.id === A.id && c.kind === "wishes");
  await P.api("feed/react", { id: aCard.id, emoji: "❤️" });
  await P.api("feed/comment", { id: aCard.id, body: "Great picks" });

  const xmas = christmas();
  const bday = (await S.api("me")).groups[0].members.find((m) => m.id === A.id).occasions.find((o) => o.birthday && !o.christmas)?.code;
  const secret = { message: randomId(), suggestion: randomId() };

  // Overnight: notifications wait for the 8 am run.
  await w.vars({ PUSH_DEV_HOUR: "22" });
  if (spoiled) {
    await S.api("claim", { itemId: ids.mixer, on: true, chipIn: true, price: 50 });
    secret.message = (await M.api("chat/send", { group, member: A.id, body: `${SPOILER} she wants the blue one`, itemId: ids.sweater })).message.id;
    // Mike shops for Alexis before they're a household: his purchases and budget for her must stay his once he joins.
    await M.api("claim", { itemId: ids.books, on: true, occasion: bday || xmas });
    await M.api("budget", { subjectId: A.id, amount: 75 });
  }
  await w.vars({ PUSH_DEV_HOUR: "8" });
  await w.cron();
  await w.vars({ PUSH_DEV_HOUR: "12" });
  // Alexis and Mike become a household (he says yes to her request) and give together from here on.
  await A.api("household/add", { memberId: M.id });
  await M.api("household/answer", { id: (await M.api("me")).me.householdInvites[0].id, accept: true });
  if (spoiled) {
    await M.api("giftcard/give", { memberId: A.id, brand: "panera", amount: 30 }); // from inside her household
    await M.api("budget", { subjectId: A.id, amount: 80 });
    await P.api("claim", { itemId: ids.mixer, on: true, chipIn: true, price: 25 });
    await S.api("claim", { itemId: ids.sweater, on: true, price: 41.23, occasion: xmas });
    await S.api("claim", { itemId: ids.books, on: true, occasion: xmas });
    await S.api("claim", { itemId: ids.lamp, on: true });
    await S.api("claim", { itemId: ids.pencils, on: true });
    await S.api("claim", { itemId: ids.coloring, on: true });
    await P.api("claim", { itemId: ids.shade, on: true });
    await S.api("giftcard/give", { memberId: A.id, brand: "starbucks", amount: 25 });
    secret.suggestion = (await S.api("idea/save", { subjectId: A.id, title: `${SPOILER} suggestion`, url: `${SHOP}suggestion`, price: 30, shared: true })).id;
    await S.api("idea/save", { subjectId: A.id, title: `${SPOILER} private idea`, note: SPOILER });
    await P.api("idea/claim", { ideaId: secret.suggestion, on: true, price: 30 });
    await S.api("chat/send", { group, member: A.id, body: `${SPOILER} I'll get the suggestion`, ideaId: secret.suggestion });
    await P.api("chat/send", { group, member: A.id, body: `${SPOILER} me too` });
    await S.api("budget", { subjectId: A.id, amount: 100 });
    await S.api("purchase/progress", { kind: "item", id: ids.sweater, occasion: xmas, status: "wrapped", stash: `${SPOILER} hall closet` });
    await S.api("nickname", { subjectId: A.id, nickname: `${SPOILER} Lex` });
    await S.api("chat/send", { group: friends.id, member: A.id, body: `${SPOILER} in the other circle` });
    // Gifts from last Christmas (the API can't backdate, so straight into the database). The next run copies them
    // into gift history: Sam's, Pat's, and one from Mike, who gives with Alexis's household.
    const last = xmas - 10000, at = new Date().toISOString(), db = await w.db();
    await db.batch([
      db.prepare("INSERT INTO gift_card_gifts (member_id, brand, season, buyer_id, amount_cents, created_at) VALUES (?, 'panera', ?, ?, 2500, ?)").bind(A.id, last, S.id, at),
      db.prepare("INSERT INTO gift_card_gifts (member_id, brand, season, buyer_id, amount_cents, created_at) VALUES (?, 'panera', ?, ?, 1500, ?)").bind(A.id, last, M.id, at),
      db.prepare("INSERT INTO idea_claims (idea_id, season, buyer_id, price_cents, created_at) VALUES (?, ?, ?, 3000, ?)").bind(secret.suggestion, last, P.id, at),
    ]);
  }
  await w.cron(); // new-wish digest
  await w.vars({ PUSH_DEV_REMIND: "1", PUSH_DEV_TODAY: String(nyToday().code) });
  await w.cron(); // birthday reminders (Alexis's is in 2 weeks, Sam's in 2 days)
  await w.vars({ PUSH_DEV_TODAY: String(daysBefore(xmas, 24)) });
  await w.cron(); // "Christmas is in 24 days. Still need a gift for ..."
  await w.vars({ PUSH_DEV_REMIND: null, PUSH_DEV_TODAY: null });

  // Alexis tidies up. A marked wish is only soft-removed (kept for its buyer); an unmarked one is deleted.
  await A.api("item/remove", { id: ids.lamp });
  await A.api("item/remove", { id: ids.mug });

  return { w, A, M, S, P, group, code, ids, secret, xmas };
}

// Everything Alexis can see or poke at, in a fixed order. Each entry: [what, route, status, body].
async function aliceView(x) {
  const { w, A, M, S, P, group, code, ids, secret, xmas } = x;
  const view = [];
  const add = (what, route, r) => view.push([what, route, r.status, r.data]);
  const get = async (what, route, path) => add(what, route, await A.raw(path));
  const post = async (what, route, path, body) => add(what, route, await A.raw(path, body));

  await get("who I am, my circles, badges", "GET me", "me");
  await get("my list", "GET list", "list");
  await get("my list by id", "GET list", `list?member=${A.id}`);
  for (const p of [M, S, P]) await get(`${p.name}'s list`, "GET list", `list?member=${p.id}`);
  const feed = (await A.api("feed")).cards;
  await get("feed", "GET feed", "feed");
  for (const c of feed) {
    await get(`comments on ${c.kind}`, "GET feed/comments", `feed/comments?id=${c.id}`);
    await get(`reactions on ${c.kind}`, "GET feed/reactions", `feed/reactions?id=${c.id}`);
  }
  await get("my ideas", "GET ideas", "ideas");
  await get("my ideas about me", "GET ideas", `ideas?subject=${A.id}`);
  await get("budget", "GET tracker", "tracker");
  await get("gift history", "GET history", "history");
  await get("gift history for me", "GET history", `history?member=${A.id}`);
  await get("inbox (she runs Hints)", "GET reports", "reports");
  await get("chat about me", "GET chat", `chat?group=${group}&member=${A.id}`);
  await get("chat about me, polling", "GET chat", `chat?group=${group}&member=${A.id}&after=2000-01-01T00:00:00.000Z`);
  const share = await w.request(`/s/${(await A.api("me")).me.shareToken}`);
  view.push(["my share page", "share page", share.status, share.data]);
  const names = await w.request("/api/lookup", { body: { code } });
  view.push(["the circle link's name list", "POST lookup", names.status, names.data]);

  // Probes: things that would answer differently if a secret existed.
  for (const [name, id] of Object.entries(ids)) {
    await post(`mark my own ${name}`, "POST claim", "claim", { itemId: id, on: true });
    await post(`unmark my own ${name}`, "POST claim", "claim", { itemId: id, on: false });
    await post(`price guess for ${name}`, "POST estimate", "estimate", { kind: "item", id });
    await post(`photo lookup for ${name}`, "POST image", "image", { kind: "item", id });
    await post(`live price for ${name}`, "POST prices", "prices", { keys: [`item:${id}`] });
    await post(`move ${name} along as Mike`, "POST purchase/progress", "purchase/progress", { kind: "item", id, occasion: xmas, status: "wrapped", buyerId: M.id });
    await post(`move ${name} along as me`, "POST purchase/progress", "purchase/progress", { kind: "item", id, occasion: xmas, status: "wrapped" });
    await post(`tag ${name} in a chat about me`, "POST chat/send", "chat/send", { group, member: A.id, body: "hi", itemId: id });
  }
  await post("write in the chat about me", "POST chat/send", "chat/send", { group, member: A.id, body: "hi" });
  await post("edit a message about me", "POST chat/edit", "chat/edit", { id: secret.message, body: "hi" });
  await post("remove a message about me", "POST chat/delete", "chat/delete", { id: secret.message });
  await post("buy a suggestion about me", "POST idea/claim", "idea/claim", { ideaId: secret.suggestion, on: true });
  await post("unbuy a suggestion about me", "POST idea/claim", "idea/claim", { ideaId: secret.suggestion, on: false });
  await post("edit a suggestion about me", "POST idea/save", "idea/save", { id: secret.suggestion, title: "x" });
  await post("remove a suggestion about me", "POST idea/remove", "idea/remove", { id: secret.suggestion });
  await post("price guess for a suggestion about me", "POST estimate", "estimate", { kind: "idea", id: secret.suggestion });
  await post("photo for a suggestion about me", "POST image", "image", { kind: "idea", id: secret.suggestion });
  await post("live price for a suggestion about me", "POST prices", "prices", { keys: [`idea:${secret.suggestion}`] });
  await post("move the suggestion along", "POST purchase/progress", "purchase/progress", { kind: "idea", id: secret.suggestion, occasion: xmas, buyerId: M.id });
  await post("give myself a gift card", "POST giftcard/give", "giftcard/give", { memberId: A.id, brand: "starbucks", on: true });
  await post("move a gift card along as Mike", "POST purchase/progress", "purchase/progress", { kind: "giftcard", id: "starbucks", subjectId: A.id, occasion: xmas, buyerId: M.id });
  await post("budget for myself", "POST budget", "budget", { subjectId: A.id, amount: 5 });
  await post("split my own household's Christmas budget", "POST budget/split", "budget/split", { subjectId: A.id, occasion: xmas, on: true });
  await post("nickname myself", "POST nickname", "nickname", { subjectId: A.id, nickname: "me" });
  await post("leave myself off my gift list", "POST budget/skip", "budget/skip", { target: `m:${A.id}`, skip: true });
  await post("did I get held wishes", "POST item/got", "item/got", { all: true, got: true });
  await post("unpublish a marked wish", "POST item/unpublish", "item/unpublish", { id: ids.sweater });
  await post("publish it again", "POST item/publish", "item/publish", { id: ids.sweater });
  await get("my list after all that", "GET list", "list");
  view.push(["my phone's notifications", "push", 200, A.pushes()]);
  return view;
}

let control, spoiled, controlView, spoiledView;
const worlds = [];
before(async () => {
  control = await build(false, worlds);
  spoiled = await build(true, worlds);
  controlView = normalizer()(await aliceView(control));
  spoiledView = normalizer()(await aliceView(spoiled));
});
after(async () => {
  for (const w of worlds) await w.close();
});

test("the secrets really happened (so the comparison means something)", async () => {
  const { A, M, S, P, ids } = spoiled;
  const hh = (await A.api("me")).me.household;
  assert.ok(hh?.members.some((m) => m.id === M.id), "Alexis and Mike are a household");
  const her = await S.api(`list?member=${A.id}`);
  const sweater = her.items.find((i) => i.id === ids.sweater);
  assert.ok(sweater.claim?.mine, "Sam sees his mark on the sweater");
  assert.ok(her.items.find((i) => i.id === ids.mixer).gift.group, "the group gift shows for Sam");
  assert.ok((await M.api(`list?member=${A.id}`)).suggestions.some((s) => s.title.includes(SPOILER)), "Mike sees Sam's suggestion");
  assert.ok((await M.api(`chat?group=${spoiled.group}&member=${A.id}`)).messages.length >= 3, "Mike reads the chat about her");
  const tags = (p) => p.pushes().map((x) => x.tag);
  assert.ok(tags(M).some((t) => t.startsWith("group:")), "Mike heard about the group gift (held overnight, sent at 8)");
  assert.ok(tags(M).some((t) => t.startsWith("chat:")), "Mike heard about the chat");
  assert.ok(P.pushes().some((x) => x.body.includes(SPOILER)), "Pat's chat notification has the message text");
  assert.ok(tags(S).some((t) => t === `bday:${A.id}`), "Sam got Alexis's birthday reminder");
  assert.ok((await S.api("history")).gifts.some((g) => g.subjectId === A.id), "last Christmas's gift card is in Sam's gift history");
  assert.ok((await M.api("history")).gifts.some((g) => g.subjectId === A.id), "and Mike's");
});

test("Alexis's view is identical whether or not anyone did anything secret", () => {
  assert.equal(spoiledView.length, controlView.length, "same number of things looked at");
  const changed = controlView.map((c, i) => [c, spoiledView[i]]).filter(([c, s]) => JSON.stringify(c) !== JSON.stringify(s));
  if (!changed.length) return;
  const list = changed.map(([[what, route]]) => `  - ${what} (${route})`).join("\n");
  // Shows the first difference in full.
  assert.deepEqual(changed[0][1], changed[0][0], `These changed because of something secret:\n${list}\nFirst one:`);
});

test("nothing Alexis can reach contains a secret", () => {
  for (const [what, route, , body] of spoiledView) {
    assert.ok(!JSON.stringify(body).includes(SPOILER), `"${what}" (${route}) shows a secret`);
  }
});

test("Alexis's phone never gets a chat, group gift or birthday reminder about herself", () => {
  const mine = spoiled.A.pushes();
  assert.ok(mine.length > 0, "she does get notifications (comments, new wishes, reminders about others)");
  for (const p of mine) {
    assert.ok(!/^(chat|group|bday):/.test(p.tag) || !p.tag.includes(spoiled.A.id), `got ${p.tag}: ${p.title}`);
    assert.ok(!p.url.includes(`/chat/`) || !p.url.includes(spoiled.A.id), `opens a chat about her: ${p.url}`);
    assert.ok(!/group gift/i.test(p.title), `group gift notification: ${p.title}`);
  }
});

// ---------- every route is accounted for ----------
// "probe": Alexis's probe above covers it (it must actually appear in the view).
// Otherwise: why it can't tell the person a surprise is about anything.
const ROUTES = {
  "POST lookup": "probe",
  "POST join": "Signs in. Answers with a token only.",
  "POST start": "Starts a circle or a solo list. Answers with a token only.",
  "GET me": "probe",
  "GET chat": "probe",
  "POST chat/send": "probe",
  "POST chat/edit": "probe",
  "POST chat/delete": "probe",
  "GET feed": "probe",
  "POST feed/post": "Answers with your own new card (same as GET feed).",
  "POST feed/edit": "Answers with your own card (same as GET feed).",
  "POST feed/delete": "Your own cards only. Answers ok.",
  "POST feed/react": "Answers with the card (same as GET feed).",
  "GET feed/reactions": "probe",
  "GET feed/comments": "probe",
  "POST feed/comment": "Answers with the comments (same as GET feed/comments).",
  "POST feed/comment/delete": "Answers with the comments (same as GET feed/comments).",
  "GET list": "probe",
  "POST item/save": "Your own wishes. Answers with the id. Never reads claims.",
  "POST item/link": "Your own wishes. Answers ok. Never reads claims.",
  "POST item/publish": "probe",
  "POST item/unpublish": "probe",
  "POST item/got": "probe",
  "POST item/thanked": "Received wishes only (already given). Answers ok.",
  "POST item/unreceive": "Received wishes only (already given). Answers ok.",
  "POST item/remove": "Answers ok whether or not it was marked (the build step removes a marked and an unmarked wish).",
  "POST claim": "probe",
  "POST giftcards/save": "Your own gift cards. Answers with the brands you sent.",
  "POST giftcard/give": "probe",
  "GET ideas": "probe",
  "POST idea/save": "probe",
  "POST idea/remove": "probe",
  "POST idea/claim": "probe",
  "POST purchase/progress": "probe",
  "POST budget/skip": "probe",
  "POST budget": "probe",
  "POST budget/split": "probe",
  "POST refresh": "Your own wishes and ideas. Counts only, never reads claims.",
  "POST estimate": "probe",
  "POST image": "probe",
  "POST prices": "probe",
  "POST preview": "Reads a store link. Nothing from the database.",
  "POST name": "Tidies a wish name with Gemini. Nothing from the database.",
  "POST identify": "Photo search. Nothing from the database.",
  "GET history": "probe",
  "GET tracker": "probe",
  "POST nickname": "probe",
  "POST family/join": "Joins a circle. Answers with its name.",
  "POST family/start": "Starts a circle. Answers with its name and code.",
  "POST family/edit": "Circle name and photo. Answers ok.",
  "POST family/admin": "Hands over admin. Answers ok.",
  "POST family/remove": "Takes someone out. Answers ok.",
  "POST family/leave": "Answers ok.",
  "GET push/key": "The app's public push key.",
  "POST push/subscribe": "Answers ok.",
  "POST push/unsubscribe": "Answers ok.",
  "POST push/prefs": "Your own switches.",
  "POST push/test": "A fixed test message to yourself.",
  "POST seen": "Answers ok.",
  "POST stale/ok": "Answers ok.",
  "POST managed/add": "Answers with the new person's id.",
  "POST managed/release": "Answers ok. Covered in handover.test.mjs.",
  "POST managed/handoff": "Answers with a name.",
  "POST managed/invite": "Answers with a link token.",
  "POST managed/uninvite": "Answers ok.",
  "POST claim/lookup": "Who a personal link is for: name, wish count, circles. Covered in handover.test.mjs.",
  "POST invite/claim": "Signs in. Covered in handover.test.mjs.",
  "POST me/link": "Answers with a link token.",
  "POST managed/remove": "Answers ok.",
  "POST household/create": "Answers with the household id.",
  "POST household/new": "Answers with ids and names.",
  "POST household/add": "Answers ok.",
  "POST household/answer": "Saying yes or no to joining a household. Answers with the household id and the people your own budgets stayed with (never about you).",
  "POST household/uninvite": "Taking back a household request. Answers ok.",
  "POST household/remove": "Answers ok.",
  "POST household/rename": "Answers ok.",
  "POST household/photo": "Answers ok.",
  "POST household/circle": "Answers ok.",
  "POST pet/save": "Answers with the pet id.",
  "POST pet/delete": "Answers ok.",
  "POST profile": "Answers ok. Moving a birthday moves others' plans silently.",
  "POST pin/clear": "Answers ok.",
  "POST pin/seen": "Answers ok.",
  "POST onboarded": "Answers ok.",
  "GET photo": "Profile, circle, household and pet photos.",
  "POST share/link": "Answers with a token. The page itself is probed.",
  "POST addkey": "Answers with a key.",
  "POST quickadd": "Saves to Maybe. Answers with a sentence about the new wish.",
  "POST report": "Answers ok.",
  "POST note": "Answers with the owner's name.",
  "GET reports": "probe",
  "POST reports/done": "Answers ok.",
  "POST reports/delete": "Answers ok.",
  "POST family/code": "Answers with a new code.",
  "POST family/request": "Answers ok.",
  "POST join/cancel": "Answers ok.",
  "POST signout/others": "Answers with a count of your own devices.",
  "POST account/delete": "Answers ok.",
  "POST passkey/new": "Passkey options for yourself: your own name and passkey ids, a challenge.",
  "POST passkey/save": "Answers with your own passkeys (device label and dates).",
  "POST passkey/remove": "Answers with your own passkeys (device label and dates).",
  "POST passkey/start": "Signed out. Answers with a challenge only.",
  "POST passkey/signin": "Signs in. Answers with a token and your own name.",
  "POST owner/find": "Owner only. Names, join dates, wish counts and circle names; nothing marked, suggested, chatted or budgeted.",
  "POST owner/trust": "Owner only. Answers ok.",
  "POST owner/delete": "Owner only. Answers ok.",
  "POST signout": "Answers ok.",
};

test("every API route is covered by a probe or has a reason it can't spoil anything", () => {
  const src = readFileSync(join(ROOT, "src/wishlist.js"), "utf8");
  const routes = [...src.matchAll(/^ {2}async "((?:GET|POST) [^"]+)"\(/gm)].map((m) => m[1]);
  assert.ok(routes.length > 50, "found the routes");
  const missing = routes.filter((r) => !(r in ROUTES));
  assert.deepEqual(missing, [], `New route(s) not in ROUTES in test/surprise.test.mjs. Add a probe to aliceView, or say why the person a surprise is about can't learn anything from it.`);
  const gone = Object.keys(ROUTES).filter((r) => !routes.includes(r));
  assert.deepEqual(gone, [], "ROUTES lists routes that no longer exist");
  const probed = new Set(controlView.map(([, route]) => route));
  const unprobed = Object.entries(ROUTES).filter(([r, why]) => why === "probe" && !probed.has(r)).map(([r]) => r);
  assert.deepEqual(unprobed, [], "marked as probed but aliceView never calls them");
});
