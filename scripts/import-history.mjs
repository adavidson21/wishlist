// Imports gift history from before Hints (your own spreadsheets) into past_totals and past_gifts (migration 0053),
// so it shows in Budget > History. Reads a CSV with the columns
//   Year, Occasion (Christmas or Birthday), Person, Gift, Price, Note, Budget, Spent
// one row per gift. Budget and Spent are the person's for that occasion, on any one of their rows (blank on the rest).
// Leave Gift blank for a row that's only a budget and total.
//
// Step 1, see who's who (read only):
//   node scripts/import-history.mjs matches --buyer <memberId> gifts.csv > matches.sql
//   npx wrangler d1 execute wishlist --remote --file matches.sql
// Lists each person in the CSV and the people in the app they match: the buyer's nickname for someone, else a
// first name (or first and last name) in one of the buyer's circles. Put the answers in a map file:
//   { "Mom": "<memberId>", "Aunt Linda": null }        (null or left out = not in the app, kept as a name)
//
// Step 2, write the SQL (back up first: npm run backup):
//   node scripts/import-history.mjs sql --buyer <memberId> --source christmas-sheet --map map.json gifts.csv > import.sql
//   npx wrangler d1 execute wishlist --remote --file import.sql
// Re-running replaces everything from the same --source for that buyer, so fixing the CSV and running again is safe.
// A birthday is dated on the person's birthday in the app (MM-DD); someone with none gets MMDD 0000.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const mode = args.shift();
const opt = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args.splice(i, 2)[1]; };
const buyer = opt("buyer"), source = opt("source") || "import", mapFile = opt("map");
const file = args[0];
if (!["matches", "sql"].includes(mode) || !buyer || !file) {
  console.error("Usage: import-history.mjs matches|sql --buyer <memberId> [--source name] [--map map.json] file.csv");
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const cents = (s) => {
  const m = String(s || "").replace(/[$,\s]/g, "").match(/^-?\d+(\.\d+)?$/);
  return m ? Math.round(parseFloat(m[0]) * 100) : null;
};
const sql = (v) => (v == null || v === "" ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const [head, ...body] = parseCsv(readFileSync(file, "utf8"));
const col = (name) => {
  const i = head.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  if (i < 0 && !["note", "price", "budget", "spent"].includes(name.toLowerCase())) throw new Error(`CSV needs a "${name}" column`);
  return i;
};
const C = { year: col("Year"), occ: col("Occasion"), person: col("Person"), gift: col("Gift"), price: col("Price"), note: col("Note"), budget: col("Budget"), spent: col("Spent") };
const get = (r, k) => (C[k] < 0 ? "" : String(r[C[k]] ?? "").trim());

const rows = body.map((r, n) => {
  const year = parseInt(get(r, "year"), 10);
  const occ = get(r, "occ").toLowerCase().startsWith("b") ? "birthday" : "christmas";
  const person = get(r, "person").replace(/\s+/g, " ");
  if (!(year > 1900 && year < 2100) || !person) throw new Error(`Row ${n + 2}: needs a Year and a Person`);
  return { year, occ, person, gift: get(r, "gift"), price: cents(get(r, "price")), note: get(r, "note"), budget: cents(get(r, "budget")), spent: cents(get(r, "spent")) };
});
const people = [...new Set(rows.map((r) => r.person))].sort();

if (mode === "matches") {
  // One query: each person, with candidate members (nickname first, then name) in the buyer's circles.
  console.log(`WITH people AS (SELECT value AS person FROM json_each(${sql(JSON.stringify(people))})),
circle AS (SELECT DISTINCT m.id, m.name, m.last_name, m.birthday FROM group_members x JOIN group_members y ON y.group_id = x.group_id
           JOIN members m ON m.id = y.member_id WHERE x.member_id = ${sql(buyer)})
SELECT p.person,
  (SELECT group_concat(n.subject_id || ' (nickname for ' || c.name || ')', '; ') FROM nicknames n JOIN circle c ON c.id = n.subject_id
    WHERE n.author_id = ${sql(buyer)} AND lower(trim(n.nickname)) = lower(p.person)) AS by_nickname,
  (SELECT group_concat(c.id || ' (' || c.name || COALESCE(' ' || c.last_name, '') || COALESCE(', birthday ' || c.birthday, '') || ')', '; ') FROM circle c
    WHERE lower(trim(c.name)) = lower(p.person) OR lower(trim(c.name || ' ' || COALESCE(c.last_name, ''))) = lower(p.person)) AS by_name
FROM people p ORDER BY p.person;`);
  process.exit(0);
}

const map = mapFile ? JSON.parse(readFileSync(mapFile, "utf8")) : {};
const memberOf = (p) => map[p] || null;
const at = new Date().toISOString();
// Christmas is YYYY1225; a birthday takes the member's MM-DD, or 0000.
const season = (r) => {
  const id = memberOf(r.person);
  if (r.occ === "christmas") return String(r.year * 10000 + 1225);
  return id
    ? `(${r.year * 10000} + COALESCE((SELECT CAST(substr(birthday, 1, 2) || substr(birthday, 4, 2) AS INTEGER) FROM members WHERE id = ${sql(id)} AND birthday GLOB '[0-9][0-9]-[0-9][0-9]'), 0))`
    : String(r.year * 10000);
};

const out = [
  `-- Hints history import: ${rows.length} rows, source ${source}, buyer ${buyer}. Generated ${at}.`,
  `DELETE FROM past_gifts WHERE buyer_id = ${sql(buyer)} AND source = ${sql(source)};`,
  `DELETE FROM past_totals WHERE buyer_id = ${sql(buyer)} AND source = ${sql(source)};`,
];
const groups = new Map();
for (const r of rows) {
  const k = `${r.year}|${r.occ}|${r.person}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
for (const [k, list] of groups) {
  const r0 = list[0];
  const budget = list.find((r) => r.budget != null)?.budget ?? null;
  const priced = list.reduce((n, r) => n + (r.price || 0), 0);
  const spent = list.find((r) => r.spent != null)?.spent ?? (priced || null);
  out.push(`INSERT OR REPLACE INTO past_totals (buyer_id, season, person, member_id, budget_cents, spent_cents, source) VALUES (${[
    sql(buyer), season(r0), sql(r0.person), sql(memberOf(r0.person)), sql(budget), sql(spent), sql(source)].join(", ")});`);
  list.filter((r) => r.gift).forEach((r, pos) => {
    const id = createHash("sha256").update(`${buyer}|${source}|${k}|${pos}`).digest("hex").slice(0, 20);
    out.push(`INSERT INTO past_gifts (id, buyer_id, season, person, member_id, title, price_cents, note, pos, source, created_at) VALUES (${[
      sql(id), sql(buyer), season(r), sql(r.person), sql(memberOf(r.person)), sql(r.gift), sql(r.price), sql(r.note), pos, sql(source), sql(at)].join(", ")});`);
  });
}
console.log(out.join("\n"));
console.error(`${groups.size} people-occasions, ${rows.filter((r) => r.gift).length} gifts, ${people.filter((p) => memberOf(p)).length} of ${people.length} people linked to the app.`);
