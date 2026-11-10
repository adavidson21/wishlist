// Worker harness for the surprise tests: the real Worker (src/worker.js) in Miniflare (workerd, which wrangler already
// installs) with a fresh local D1 built from migrations/, plus a
// fake push service that decrypts every notification (RFC 8291) so tests can read exactly what each phone shows.
// test/harness.mjs is lighter (node:sqlite, routes called directly); this one is for what that can't do: the hourly
// Cron Trigger, background notifications (ctx.waitUntil), restarts with new bindings, and encrypted pushes.
// No network: the pretend store (SHOP) answers with product pages, every other outbound request gets a 404.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { buildSync } from "esbuild";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUSH = "https://push.test/";
// A pretend store: every page is a product with a price, a photo and stock, like a real shop's JSON-LD.
export const SHOP = "https://shop.hints-test.com/";
function shopPage(url) {
  const u = new URL(url);
  if (u.pathname.endsWith(".png")) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  const name = u.pathname.slice(1) || "thing";
  const ld = { "@context": "https://schema.org", "@type": "Product", name, image: `${SHOP}${name}.png`,
    offers: { "@type": "Offer", price: "19.99", priceCurrency: "USD", availability: "https://schema.org/InStock" } };
  return new Response(`<!doctype html><html><head><title>${name}</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- SQL migrations ----------
// D1's exec splits on newlines, so statements are split here: comments dropped, then split on ";" outside quotes.
function splitSql(sql) {
  const out = [];
  let cur = "", q = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; cur += "\n"; continue; }
    if (q) { if (c === q) q = null; cur += c; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const MIGRATIONS = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => splitSql(readFileSync(join(ROOT, "migrations", f), "utf8")));

// The Worker, bundled the way wrangler bundles it for a deploy (esbuild), so npm packages it imports
// (@simplewebauthn/server for passkeys) resolve, and node: built-ins are left to workerd.
const BUNDLE_DIR = mkdtempSync(join(tmpdir(), "hints-bundle-"));
buildSync({
  entryPoints: [join(ROOT, "src/worker.js")], outfile: join(BUNDLE_DIR, "worker.js"),
  bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker", "browser"],
  external: ["node:*"], logLevel: "error",
});
process.on("exit", () => rmSync(BUNDLE_DIR, { recursive: true, force: true }));
const MODULES = [{ type: "ESModule", path: join(BUNDLE_DIR, "worker.js") }];
// Same compatibility flags as wrangler.jsonc (nodejs_als: the per-request scope in src/limits.js).
const FLAGS = JSON.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8").match(/"compatibility_flags":\s*(\[[^\]]*\])/)?.[1] || "[]");

// ---------- push decryption (the browser's side of RFC 8291) ----------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const concat = (...parts) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let a = 0; for (const p of parts) { o.set(p, a); a += p.length; } return o; };
async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}
async function newSubscription(name) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = `${PUSH}${name}/${b64u(crypto.getRandomValues(new Uint8Array(12)))}`;
  return { endpoint, keys: { p256dh: b64u(pub), auth: b64u(auth) }, secret: { pair, pub, auth } };
}
async function decrypt(secret, body) {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const asPublic = body.slice(21, 21 + idLen);
  const cipher = body.slice(21 + idLen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, secret.pair.privateKey, 256));
  const ikm = await hkdf(secret.auth, shared, concat(enc.encode("WebPush: info\0"), secret.pub, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--; // padding, then the 0x02 delimiter
  return JSON.parse(dec.decode(plain.slice(0, end)));
}

// ---------- dates (New York, like the app) ----------
export function nyToday(offsetDays = 0) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + offsetDays));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), code: d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(),
    mmdd: `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}` };
}
// This season's Christmas (YYYYMMDD), and the day `n` days before it.
export function christmas() {
  const t = nyToday();
  const y = t.code > t.y * 10000 + 1225 ? t.y + 1 : t.y;
  return y * 10000 + 1225;
}
export function daysBefore(code, n) {
  const d = new Date(Date.UTC(Math.floor(code / 10000), Math.floor(code / 100) % 100 - 1, (code % 100) - n));
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// ---------- a world: one Worker + one database ----------
// vars: Worker bindings (PUSH_DEV_HOUR defaults to noon so nothing is held for quiet hours).
export async function world(vars = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hints-test-"));
  const pushes = []; // { to: person name, endpoint, payload }
  const subs = new Map(); // endpoint -> { name, secret }
  let inflight = 0;
  let current = { PUSH_DEV_ENDPOINT: PUSH, PUSH_DEV_HOUR: "12", ...vars };
  // Miniflare 5 takes a new options shape; it still converts the classic one, which is what's written here.
  const options = () => convertV4MiniflareOptions({
    resourcePersistencePath: join(dir, "data"),
    modules: MODULES,
    modulesRoot: BUNDLE_DIR,
    compatibilityDate: "2025-09-01",
    compatibilityFlags: FLAGS,
    d1Databases: { DB: "wishlist" },
    bindings: current,
    outboundService: async (req) => {
      if (req.url.startsWith(SHOP)) return shopPage(req.url);
      if (!req.url.startsWith(PUSH)) return new Response("", { status: 404 });
      inflight++;
      try {
        const sub = subs.get(req.url);
        const body = new Uint8Array(await req.arrayBuffer());
        if (sub) pushes.push({ to: sub.name, endpoint: req.url, payload: await decrypt(sub.secret, body) });
        return new Response(null, { status: sub ? 201 : 410 });
      } finally {
        inflight--;
      }
    },
  });
  const mf = new Miniflare(options());
  await mf.ready;
  const db = await mf.getD1Database("DB");
  for (const stmts of MIGRATIONS) if (stmts.length) await db.batch(stmts.map((s) => db.prepare(s)));

  let ip = 1;
  async function request(path, { token, body, method } = {}) {
    const headers = { "cf-connecting-ip": `10.0.0.${ip}` };
    if (token) headers["x-wishlist-token"] = token;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await mf.dispatchFetch(`https://hints.test${path}`, { method: method || (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data };
  }
  // Background work (ctx.waitUntil: chat and group gift notifications) finishes after the response.
  async function settle() {
    let last = -1, quiet = 0;
    while (quiet < 3) {
      await new Promise((r) => setTimeout(r, 60));
      if (inflight === 0 && pushes.length === last) quiet++;
      else quiet = 0;
      last = pushes.length;
    }
  }

  // Calls that start a notification in the background (ctx.waitUntil). After these, wait for it to land.
  const BACKGROUND = new Set(["chat/send", "claim", "feed/comment"]);
  // A signed-in person. api(path, body?) throws on an error status; raw() returns { status, data } either way.
  function person(name, token, id) {
    const p = {
      name, token, id,
      async raw(path, body) {
        const r = await request(`/api/${path}`, { token: p.token, body });
        if (BACKGROUND.has(path.split("?")[0])) await settle();
        return r;
      },
      async api(path, body) {
        const r = await p.raw(path, body);
        if (r.status >= 400) throw new Error(`${name} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
        return r.data;
      },
      async subscribe() {
        const sub = await newSubscription(name);
        subs.set(sub.endpoint, { name, secret: sub.secret });
        await p.api("push/subscribe", { subscription: { endpoint: sub.endpoint, keys: sub.keys } });
        return sub.endpoint;
      },
      // What this person's phone received (decrypted), in order.
      pushes: () => pushes.filter((x) => x.to === name).map((x) => x.payload),
    };
    return p;
  }

  async function signedIn(name, token) {
    const me = (await request("/api/me", { token })).data;
    return person(name, token, me.me.id);
  }

  return {
    mf, pushes, request, settle,
    // The database, for setting up what the API can't (like gifts from last year). Fetched fresh each time, since a
    // restart (vars) replaces it.
    db: () => mf.getD1Database("DB"),
    async start(name, pin, groupName) {
      ip++;
      const r = await request("/api/start", { body: { name, pin, groupName } });
      if (r.status !== 200) throw new Error(`start ${JSON.stringify(r.data)}`);
      return signedIn(name, r.data.token);
    },
    async join(code, name, pin) {
      ip++;
      const r = await request("/api/join", { body: { code, name, pin } });
      if (r.status !== 200) throw new Error(`join ${JSON.stringify(r.data)}`);
      return signedIn(name, r.data.token);
    },
    // Changes Worker bindings (restarts the Worker; the database is kept on disk).
    async vars(change) {
      current = { ...current, ...change };
      for (const [k, v] of Object.entries(current)) if (v === null) delete current[k];
      await mf.setOptions(options());
    },
    // One run of the hourly Cron Trigger.
    async cron() {
      const w = await mf.getWorker();
      await w.scheduled({ cron: "0 * * * *" });
      await settle();
    },
    async close() {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------- comparing what someone sees ----------
// Ids (16 lowercase letters/digits), timestamps, join codes and tokens differ between two worlds even when everything
// else is the same. They're replaced in order of first appearance, so two snapshots of the same thing come out equal.
const ID = /\b[a-z0-9]{16}\b/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const SECRET_KEYS = new Set(["code", "shareToken", "token", "key"]);
export function normalizer() {
  const ids = new Map();
  const str = (s) => s.replace(ISO, "<time>").replace(ID, (m) => (ids.has(m) ? ids.get(m) : (ids.set(m, `<id${ids.size + 1}>`), ids.get(m))))
    .replace(/\/s\/[A-Za-z0-9_-]{22,40}/g, "/s/<token>");
  const walk = (v, key) => {
    if (typeof v === "string") return SECRET_KEYS.has(key) ? "<secret>" : str(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [str(k), walk(x, k)]));
    return v;
  };
  return walk;
}
