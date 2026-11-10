// Test harness: the real API (src/wishlist.js routes) on an in-memory SQLite database with every migration
// applied, behind a small shim with D1's API (prepare/bind/first/all/run/batch). No new dependencies: node:sqlite
// ships with Node 22. Foreign keys are on, like D1.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { routes } from "../src/wishlist.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

function norm(v) {
  if (v === undefined) throw new Error("D1_TYPE_ERROR: undefined bound to a query");
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

// A D1-like wrapper around a node:sqlite database.
export function d1(db) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a.map(norm)),
    async first(col) {
      const row = db.prepare(sql).get(...args);
      if (!row) return null;
      const out = { ...row };
      return col ? out[col] ?? null : out;
    },
    async all() {
      return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })), success: true, meta: {} };
    },
    async run() {
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async raw() {
      return db.prepare(sql).all(...args).map((r) => Object.values(r));
    },
    _exec() {
      const s = db.prepare(sql);
      if (s.columns().length) return { results: s.all(...args).map((r) => ({ ...r })), success: true, meta: {} };
      const r = s.run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec("BEGIN");
      try {
        const out = list.map((s) => s._exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
  };
}

// A fresh database with every migration applied, in the order wrangler applies them (by file name).
export function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  }
  return db;
}

// A small world builder plus an API caller.
//   const w = world();
//   const c = w.circle("Family");
//   const alexis = w.person("Alexis", { circle: c }); // signed in (has a token)
//   w.household([alexis, mike]); // puts them in one household, synced into the household's circles
//   await w.api(alexis, "POST budget", { ... })
export function world() {
  const db = freshDb();
  const env = { DB: d1(db), GEMINI_DAILY_CAP: "0" };
  let n = 0;
  const id = (p) => `${p}${++n}`.padEnd(8, "x");
  const t = "2026-01-01T00:00:00.000Z";
  const w = {
    db,
    env,
    sql: (q, ...a) => db.prepare(q).all(...a.map(norm)).map((r) => ({ ...r })),
    run: (q, ...a) => db.prepare(q).run(...a.map(norm)),
    circle(name = "Family") {
      const g = id("g");
      w.run("INSERT INTO groups (id, name, join_code, created_at) VALUES (?, ?, ?, ?)", g, name, `C${n}ODE`, t);
      return g;
    },
    // opts: circle (or circles), managedBy (someone who doesn't use the app), birthday "MM-DD", lastName
    person(name, opts = {}) {
      const m = id("m");
      w.run("INSERT INTO members (id, name, created_at, pin_hash, onboarded_at, managed_by, birthday, last_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        m, name, t, "x", t, opts.managedBy?.id || null, opts.birthday || null, opts.lastName || null);
      for (const g of [].concat(opts.circle || opts.circles || [])) {
        w.run("INSERT INTO group_members (group_id, member_id, joined_at, direct) VALUES (?, ?, ?, 1)", g, m, t);
        // The first person in becomes the admin (groups.created_by).
        w.run("UPDATE groups SET created_by = COALESCE(created_by, ?) WHERE id = ?", m, g);
      }
      const token = opts.managedBy ? null : `tok_${m}`;
      if (token) w.run("INSERT INTO devices (token, member_id, created_at, last_seen) VALUES (?, ?, ?, ?)", token, m, t, new Date().toISOString());
      return { id: m, name, token };
    },
    // Puts people in one new household (in every circle any of them is in), returns its id.
    household(people, name = null) {
      const h = id("h");
      w.run("INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)", h, name, t);
      for (const p of people) w.run("UPDATE members SET household_id = ? WHERE id = ?", h, p.id);
      const circles = new Set(people.flatMap((p) => w.sql("SELECT group_id FROM group_members WHERE member_id = ?", p.id).map((r) => r.group_id)));
      for (const g of circles) {
        w.run("INSERT INTO group_households (group_id, household_id, added_at) VALUES (?, ?, ?)", g, h, t);
        for (const p of people) w.run("INSERT INTO group_members (group_id, member_id, joined_at, direct) VALUES (?, ?, ?, 0) ON CONFLICT DO NOTHING", g, p.id, t);
      }
      return h;
    },
    // A published wish on `owner`'s list.
    item(owner, title = "Gift", price = 2000) {
      const i = id("i");
      w.run("INSERT INTO items (id, owner_id, title, price_cents, created_at, updated_at, draft) VALUES (?, ?, ?, ?, ?, ?, 0)", i, owner.id, title, price, t, t);
      return i;
    },
    // `buyer` bought wish `item` for `occasion` (default this Christmas), paying `paid` cents (null = the list price).
    buy(buyer, item, occasion = xmasCode(), paid = null) {
      w.run("INSERT INTO claims (item_id, season, buyer_id, created_at, price_cents) VALUES (?, ?, ?, ?, ?)", item, occasion, buyer.id, new Date().toISOString(), paid);
    },
    // Calls the API as `who` (a person from person(), or null). Returns { status, body }.
    async call(who, key, body) {
      const [method, action] = key.split(" ");
      const qs = method === "GET" && body ? `?${new URLSearchParams(body)}` : "";
      const headers = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" };
      if (who?.token) headers["x-wishlist-token"] = who.token;
      const req = new Request(`https://hints.test/api/${action}${qs}`, { method, headers, body: method === "POST" ? JSON.stringify(body || {}) : undefined });
      const handler = routes[`/api/${action}`];
      if (!handler) throw new Error(`No route ${key}`);
      const res = await handler(req, env, { waitUntil() {} });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    // Like call(), but throws unless it's a 2xx. Returns the body.
    async api(who, key, body) {
      const r = await w.call(who, key, body);
      if (r.status >= 300) throw new Error(`${key} as ${who?.name}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
  };
  return w;
}

// This year's Christmas occasion code (YYYYMMDD) as the API files it, matching today in New York.
export function xmasCode() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const y = Number(p.year) + (Number(p.month) === 12 && Number(p.day) > 25 ? 1 : 0);
  return y * 10000 + 1225;
}
