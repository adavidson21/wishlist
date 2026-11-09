// Fails when two API handlers share a route key ("POST claim" twice). In an object literal the later one
// silently replaces the earlier, so this is otherwise invisible until something breaks in the app.
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/wishlist.js", import.meta.url), "utf8");
const seen = new Map();
let bad = 0;
src.split("\n").forEach((line, i) => {
  const m = line.match(/^ {2}async "((?:GET|POST) [^"]+)"\(/);
  if (!m) return;
  if (seen.has(m[1])) { console.error(`Duplicate route "${m[1]}" at src/wishlist.js:${seen.get(m[1])} and :${i + 1}`); bad++; }
  else seen.set(m[1], i + 1);
});
if (bad) process.exit(1);
console.log(`Routes OK (${seen.size})`);
