// npm run compare-budgets -- backups/hints-2026-11-10-14-00.sql
// Checks a change against real data before it ships: loads a backup (from `npm run backup`) into memory twice,
// applies the migrations the live database doesn't have yet to the second copy, then asks the API (this checkout's
// code) for every person's Budget page on both and prints what changed: budget and spent per person and occasion.
// Nothing is sent anywhere and the backup file isn't changed. Run it on main and on a branch to compare code too.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { d1 } from "../test/harness.mjs";
import { routes } from "../src/wishlist.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run compare-budgets -- <backup .sql file>");
  process.exit(1);
}
const dump = readFileSync(file, "utf8");
const MIGRATIONS = new URL("../migrations/", import.meta.url);

function load(applyPending) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(dump);
  const done = new Set();
  try { for (const r of db.prepare("SELECT name FROM d1_migrations").all()) done.add(r.name); } catch {}
  const pending = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && !done.has(f)).sort();
  if (applyPending) for (const f of pending) db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  db.exec("PRAGMA foreign_keys = ON");
  return { db, pending };
}

async function snapshot(db) {
  const env = { DB: d1(db) };
  const people = db.prepare("SELECT id, name FROM members WHERE managed_by IS NULL").all();
  const rows = new Map();
  for (const p of people) {
    const token = `compare_${p.id}`;
    db.prepare("INSERT OR REPLACE INTO devices (token, member_id, created_at, last_seen) VALUES (?, ?, ?, ?)").run(token, p.id, new Date().toISOString(), new Date().toISOString());
    const res = await routes["/api/tracker"](new Request("https://hints.test/api/tracker", { headers: { "x-wishlist-token": token } }), env, { waitUntil() {} });
    const t = await res.json();
    if (!res.ok) { rows.set(`${p.name}: error`, t.error); continue; }
    for (const s of t.people || []) {
      for (const o of s.occasions) {
        const who = o.household ? t.households[o.household]?.label : s.name;
        rows.set(`${p.name} → ${who} (${o.code})`, `budget ${o.budget_cents ?? "none"}, spent ${o.spent_cents}`);
      }
    }
  }
  return rows;
}

const before = load(false);
const after = load(true);
console.log(`Migrations not yet on the live database: ${after.pending.length ? after.pending.join(", ") : "none"}`);
const [a, b] = [await snapshot(before.db), await snapshot(after.db)];
let changed = 0;
for (const k of new Set([...a.keys(), ...b.keys()])) {
  if (a.get(k) === b.get(k)) continue;
  changed++;
  console.log(`${k}\n  before: ${a.get(k) ?? "(not shown)"}\n  after:  ${b.get(k) ?? "(not shown)"}`);
}
console.log(changed ? `\n${changed} change${changed === 1 ? "" : "s"}. Check each one is expected before deploying.` : "\nNo changes to anyone's budgets.");
