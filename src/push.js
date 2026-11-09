// Web Push with no libraries and no paid service: VAPID signing (RFC 8292) and aes128gcm payload encryption
// (RFC 8291), all with WebCrypto. The VAPID key pair is made the first time it's needed and kept in D1
// (app_keys, migration 0026), so there's nothing to set up.

const enc = new TextEncoder();
// Apple rejects a token whose subject isn't a URL or mailto:, so this is the app's own address.
const SUBJECT = "https://hints.alexisdavidson.org";
// Only real browser push services, so a made-up subscription can't point the Worker at some other server.
const PUSH_HOSTS = [".googleapis.com", ".mozilla.com", ".mozaws.net", ".apple.com", ".windows.com", ".microsoft.com"];

export const b64u = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s) => {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "===".slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// env.PUSH_DEV_ENDPOINT (local .dev.vars only, never in production) lets tests use a fake push service.
export function pushEndpointOk(endpoint, env = {}) {
  if (env.PUSH_DEV_ENDPOINT && String(endpoint).startsWith(env.PUSH_DEV_ENDPOINT)) return true;
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && endpoint.length <= 1000 && PUSH_HOSTS.some((h) => u.hostname.endsWith(h));
  } catch {
    return false;
  }
}

let cached = null;
// { key: CryptoKey (ECDSA P-256 private), pub: base64url raw public key (the app's applicationServerKey) }.
export async function vapidKeys(env) {
  if (cached?.db === env.DB) return cached;
  const read = () => env.DB.prepare("SELECT value FROM app_keys WHERE name = 'vapid'").first();
  let row = await read();
  if (!row) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const pub = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
    // OR IGNORE: if two requests race, the first key wins and both read it back.
    await env.DB.prepare("INSERT OR IGNORE INTO app_keys (name, value) VALUES ('vapid', ?)").bind(JSON.stringify({ jwk, pub })).run();
    row = await read();
  }
  const { jwk, pub } = JSON.parse(row.value);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  cached = { db: env.DB, key, pub };
  return cached;
}

// One signed token per push service (origin), reused for an hour (it's valid for 12), so a run that sends many
// notifications signs once per service instead of once per notification. Saves CPU on the free plan.
const tokens = new Map();
async function vapidHeader(env, endpoint) {
  const { key, pub } = await vapidKeys(env);
  const aud = new URL(endpoint).origin;
  const hit = tokens.get(aud);
  if (hit && hit.pub === pub && hit.until > Date.now()) return hit.header;
  const part = (o) => b64u(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })}`;
  // WebCrypto's ECDSA signature is already r || s, which is what a JWT wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  const header = `vapid t=${unsigned}.${b64u(sig)}, k=${pub}`;
  tokens.set(aud, { header, pub, until: Date.now() + 3600_000 });
  return header;
}

async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

// RFC 8291: encrypts `text` for one subscription ({ p256dh, auth }, base64url). Returns the request body.
export async function encryptPayload(sub, text) {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the text, then 0x02 (last record, no padding).
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// Sends one notification. payload: { title, body, url, tag }. Returns the push service's status code;
// 404 and 410 mean the subscription is gone (the caller deletes it).
export async function sendPush(env, sub, payload) {
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidHeader(env, sub.endpoint),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "normal",
    },
    body: await encryptPayload(sub, JSON.stringify(payload)),
  });
  if (res.status >= 400) console.error("push", res.status, new URL(sub.endpoint).hostname, (await res.text().catch(() => "")).slice(0, 200));
  return res.status;
}
