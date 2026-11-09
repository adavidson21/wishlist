// npm run backup: saves a full copy of the live Hints database (schema and data, as SQL) to backups/ on this
// computer. backups/ is in .gitignore, so it never ends up on GitHub. Keeps the newest 12 and deletes older ones.
// Needs `npx wrangler login` once. Restoring: see "Backups and restore" in docs/DEVELOPERS.md.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const KEEP = 12;
const dir = new URL("../backups/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const file = join(dir, `hints-${stamp}.sql`);

const run = spawnSync("npx", ["wrangler", "d1", "export", "wishlist", "--remote", "--output", file], { stdio: "inherit", shell: process.platform === "win32" });
if (run.status !== 0) {
  console.error("\nBackup failed. If wrangler asked you to log in, run `npx wrangler login` and try again.");
  process.exit(run.status || 1);
}
const kb = Math.round(statSync(file).size / 1024);
console.log(`\nSaved ${file} (${kb} KB)`);

const old = readdirSync(dir).filter((f) => /^hints-.*\.sql$/.test(f)).sort().reverse().slice(KEEP);
for (const f of old) unlinkSync(join(dir, f));
if (old.length) console.log(`Deleted ${old.length} older backup${old.length === 1 ? "" : "s"} (keeping the newest ${KEEP}).`);
