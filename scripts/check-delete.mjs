// Fails when a table could hold someone's information but Delete my Hints (deleteMember in src/wishlist.js,
// with feedForget and leaveHousehold) never mentions it. New tables must be handled there, or listed in SKIP
// with the reason they don't need it.
import { readFileSync, readdirSync } from "node:fs";
const src = readFileSync(new URL("../src/wishlist.js", import.meta.url), "utf8");
const dir = new URL("../migrations/", import.meta.url);
const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");

const SKIP = {
  members: "the person's own row, deleted last",
  groups: "circles: one only they used is deleted with them; others get a new admin",
  households: "a household outlives one person (leaveHousehold hands its pets over and drops it when empty)",
  rate_limits: "counters, swept within two days",
  app_keys: "app-wide keys (push), nobody's information",
  push_sent: "keys of reminders already sent, swept after two days to 400 days",
  claims_new: "temporary table from a migration, renamed to claims",
  fill_log: "store hosts and hit or miss only (no person, link or product), swept after 60 days",
};

const tables = [...new Set([...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gi)].map((m) => m[1]))];
const body = (name) => {
  const start = src.search(new RegExp(`(?:async function|function|const) ${name}\\b`));
  if (start < 0) throw new Error(`check-delete: can't find ${name} in src/wishlist.js`);
  const next = src.slice(start + 1).search(/\n(?:async function|function|const|let) [A-Za-z]/);
  return src.slice(start, next < 0 ? undefined : start + 1 + next);
};
const handled = ["deleteMember", "feedForget", "leaveHousehold"].map(body).join("\n");
const missing = tables.filter((t) => !SKIP[t] && !new RegExp(`\\b${t}\\b`).test(handled));
if (missing.length) {
  console.error(`Delete my Hints doesn't handle: ${missing.join(", ")}. Add them to deleteMember() in src/wishlist.js, or to SKIP in scripts/check-delete.mjs with a reason.`);
  process.exit(1);
}
console.log(`Delete OK (${tables.length} tables)`);
