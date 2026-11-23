// Gift history from before Hints (scripts/import-history.mjs -> past_totals, past_gifts; migration 0053).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { world } from "./harness.mjs";

const SCRIPT = new URL("../scripts/import-history.mjs", import.meta.url).pathname;
const CSV = `Year,Occasion,Person,Gift,Price,Note,Budget,Spent
2024,Christmas,Mom,Crockpot,15.00,half of $30,100.00,140.00
2024,Christmas,Mom,"Bed Set, Pillows",100.00,,,
2024,Christmas,Aunt Linda,Picture Frame,,,20.00,6.00
2023,Christmas,Mike,Dash Cam,100.00,,,
2021,Birthday,Mom,Vera Bradley Blanket,85.00,,150.00,
`;

function run(mode, buyer, map, csv = CSV) {
  const dir = mkdtempSync(join(tmpdir(), "hints-import-"));
  writeFileSync(join(dir, "g.csv"), csv);
  writeFileSync(join(dir, "map.json"), JSON.stringify(map));
  return execFileSync("node", [SCRIPT, mode, "--buyer", buyer, "--source", "sheet", "--map", join(dir, "map.json"), join(dir, "g.csv")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function family() {
  const w = world();
  const c = w.circle("Family");
  const alexis = w.person("Alexis", { circle: c });
  const mike = w.person("Mike", { circle: c });
  const mom = w.person("Diane", { circle: c, birthday: "03-05" });
  w.household([alexis, mike]);
  w.run("INSERT INTO nicknames (author_id, subject_id, nickname, updated_at) VALUES (?, ?, 'Mom', 'x')", alexis.id, mom.id);
  const map = { Mom: mom.id, Mike: mike.id };
  w.db.exec(run("sql", alexis.id, map));
  return { w, alexis, mike, mom, map };
}

test("imported years show in History with budgets, totals and people who aren't in the app", async () => {
  const { w, alexis, mom } = family();
  const h = await w.api(alexis, "GET history");
  const titles = h.gifts.map((g) => `${g.season} ${g.subjectName}: ${g.title}`);
  assert.deepEqual(titles, [
    "20241225 Aunt Linda: Picture Frame",
    "20241225 Mom: Crockpot",
    "20241225 Mom: Bed Set, Pillows",
    "20231225 Mike: Dash Cam",
    "20210305 Mom: Vera Bradley Blanket",
  ]);
  const momGift = h.gifts.find((g) => g.title === "Crockpot");
  assert.equal(momGift.subjectId, mom.id);
  assert.equal(momGift.spent_cents, 1500);
  assert.equal(momGift.note, "half of $30");
  assert.equal(h.gifts.find((g) => g.title === "Picture Frame").subjectId, null);
  const t = (season, name) => h.totals.find((x) => x.season === season && x.subjectName === name);
  assert.equal(t(20241225, "Mom").budget_cents, 10000);
  assert.equal(t(20241225, "Mom").spent_cents, 14000);
  assert.equal(t(20211225 - 1225 + 305, "Mom").spent_cents, 8500, "blank Spent falls back to the gift prices");
  // On Mom's page.
  const mine = await w.api(alexis, "GET history", { member: mom.id });
  assert.equal(mine.gifts.length, 3);
  assert.ok(mine.gifts.every((g) => g.subjectId === mom.id));
});

test("re-running the import replaces it instead of doubling up", async () => {
  const { w, alexis, map } = family();
  w.db.exec(run("sql", alexis.id, map));
  w.db.exec(run("sql", alexis.id, map, CSV.replace("Picture Frame", "Photo Frame")));
  const h = await w.api(alexis, "GET history");
  assert.equal(h.gifts.length, 5);
  assert.ok(h.gifts.some((g) => g.title === "Photo Frame"));
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM past_totals")[0].n, 4);
});

test("your household sees it for people outside the household; the people it was for never do", async () => {
  const { w, mike, mom } = family();
  const h = await w.api(mike, "GET history");
  assert.deepEqual(h.gifts.map((g) => g.title).sort(), ["Bed Set, Pillows", "Crockpot", "Picture Frame", "Vera Bradley Blanket"]);
  assert.ok(h.gifts.every((g) => g.by === "Alexis"));
  assert.ok(!h.totals.some((x) => x.subjectName === "Mike"), "Mike doesn't see what Alexis spent on him");
  const seen = JSON.stringify([await w.api(mom, "GET history"), await w.api(mom, "GET tracker")]);
  assert.ok(!/Crockpot|Blanket|Pillows/.test(seen), "Mom sees nothing");
});

test("matches lists nickname and name matches in the buyer's circles", () => {
  const { w, alexis, mom } = family();
  const rows = w.sql(run("matches", alexis.id, {}));
  const byPerson = Object.fromEntries(rows.map((r) => [r.person, r]));
  assert.match(byPerson.Mom.by_nickname, new RegExp(mom.id));
  assert.match(byPerson.Mike.by_name, /Mike/);
  assert.equal(byPerson["Aunt Linda"].by_name, null);
});

test("deleting a recipient keeps the gift as a name; deleting the buyer removes their imports", async () => {
  const { w, alexis, mom } = family();
  w.run("UPDATE members SET pin_hash = NULL WHERE id IN (?, ?)", alexis.id, mom.id);
  await w.api(mom, "POST account/delete", {});
  const left = w.sql("SELECT member_id FROM past_gifts WHERE person = 'Mom'");
  assert.equal(left.length, 3);
  assert.ok(left.every((r) => r.member_id === null));
  await w.api(alexis, "POST account/delete", {});
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM past_gifts")[0].n, 0);
  assert.equal(w.sql("SELECT COUNT(*) AS n FROM past_totals")[0].n, 0);
});
