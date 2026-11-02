-- Explicit opt-in keeps existing Google ownership independent of email strings.
CREATE TABLE cloud_email_login (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  enabled_at INTEGER NOT NULL
);
CREATE TABLE cloud_email_cooldown (
  email_hash TEXT PRIMARY KEY NOT NULL,
  next_send_at INTEGER NOT NULL
);
CREATE INDEX cloud_email_cooldown_expiry ON cloud_email_cooldown(next_send_at);
