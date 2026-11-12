// Saves a real store page as a parser test fixture (test/fixtures/<name>.html), run from your own computer so the
// store sends the real page instead of a bot check. Keeps only <head> and the JSON-LD scripts (what autofill reads),
// so fixtures stay small. Then add a case for it in test/parsers.test.mjs.
//
//   node scripts/save-fixture.mjs https://www.target.com/p/-/A-88403445 target-stanley
import { writeFileSync, mkdirSync } from "node:fs";

const [url, name] = process.argv.slice(2);
if (!url || !/^[a-z0-9-]+$/.test(name || "")) {
  console.error("Usage: node scripts/save-fixture.mjs <product url> <fixture-name (letters, numbers, dashes)>");
  process.exit(2);
}
const res = await fetch(url, {
  headers: {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9",
  },
});
const html = await res.text();
const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] || "";
const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi)].map((m) => m[0]).filter((s) => !head.includes(s));
const out = `<!-- ${url} saved ${new Date().toISOString().slice(0, 10)} (HTTP ${res.status}) -->\n<html>${head}<body>\n${ld.join("\n")}\n</body></html>\n`;
mkdirSync(new URL("../test/fixtures/", import.meta.url), { recursive: true });
writeFileSync(new URL(`../test/fixtures/${name}.html`, import.meta.url), out);
console.log(`Saved test/fixtures/${name}.html (${Math.round(out.length / 1024)} KB, HTTP ${res.status}, ${ld.length} extra JSON-LD block(s)).`);
