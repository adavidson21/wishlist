-- Hints: counters for abuse limits (src/limits.js). One row per key per time window: sign-ups per IP,
-- wrong PINs per person, invite code lookups, Gemini calls per day, and so on. Rows older than two days
-- are swept by the app. Nothing personal is kept here beyond an IP prefix or a member id in the key.
CREATE TABLE rate_limits (
  key    TEXT NOT NULL,    -- what is counted, e.g. "pinfail:m:<memberId>@900"
  bucket INTEGER NOT NULL, -- start of the window, epoch seconds
  count  INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
);
CREATE INDEX rate_limits_bucket ON rate_limits(bucket);

-- Signing in caps devices per person (oldest signed out first).
CREATE INDEX IF NOT EXISTS devices_member ON devices(member_id, last_seen);
