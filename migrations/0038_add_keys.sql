-- Hints: a personal "add key" for the iPhone Shortcut that adds a shared link to your Maybe list (POST /api/quickadd).
-- Only the SHA-256 of the key is kept. NULL = off. A new key replaces the old one.
ALTER TABLE members ADD COLUMN add_key_hash TEXT;
CREATE UNIQUE INDEX members_add_key ON members(add_key_hash);
