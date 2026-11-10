-- Hints: getting ready for strangers (docs/plans/public-launch.md).

-- Circles started from now on don't hand a set-up list over from the circle link ("Ready for you"): anyone with
-- the circle code could take over a list that isn't theirs. The admin sends that person their own link instead.
-- Circles that already exist keep working as before (1).
ALTER TABLE groups ADD COLUMN link_claims INTEGER NOT NULL DEFAULT 0;
UPDATE groups SET link_claims = 1;

-- Passkeys: sign in with Face ID or a fingerprint, synced by iCloud Keychain or Google Password Manager, so
-- someone who loses their phone and sign-in link can still get back in. Only the public key is kept.
CREATE TABLE passkeys (
  id         TEXT PRIMARY KEY,                       -- credential id (base64url)
  member_id  TEXT NOT NULL REFERENCES members(id),
  public_key TEXT NOT NULL,                          -- COSE public key (base64url)
  counter    INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                                   -- JSON array, e.g. ["internal","hybrid"]
  label      TEXT,                                   -- "iPhone", "Mac", ... from the browser at the time
  created_at TEXT NOT NULL,
  last_used  TEXT
);
CREATE INDEX passkeys_member ON passkeys(member_id);

-- One-time challenges for making and using a passkey. Kept 5 minutes; swept by the app.
CREATE TABLE passkey_challenges (
  id        TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  member_id TEXT,      -- set when making a passkey (signed in), NULL when signing in with one
  expires   TEXT NOT NULL
);

-- Trusted accounts: only the whole-app Gemini cap applies to them, no per-person or new-account limits
-- (src/limits.js geminiAllowed). Everyone already on Hints when public sign-ups open is trusted; whoever runs
-- Hints can raise anyone else later (Settings > Inbox, "Raise AI limit").
ALTER TABLE members ADD COLUMN ai_trusted INTEGER NOT NULL DEFAULT 0;
UPDATE members SET ai_trusted = 1;
