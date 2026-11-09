-- Hints: forgotten PINs. Someone in your household, or the admin of a circle you're in, can clear your PIN
-- (there's no email to reset it with). Who did it and when is kept so you see a notice next time you open
-- the app; both go back to NULL once you set a new PIN or dismiss the notice.
ALTER TABLE members ADD COLUMN pin_cleared_by TEXT REFERENCES members(id);
ALTER TABLE members ADD COLUMN pin_cleared_at TEXT;
