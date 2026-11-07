CREATE TABLE cloud_master_pin (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  verifier_json TEXT,
  setup_required INTEGER NOT NULL DEFAULT 1 CHECK(setup_required IN (0, 1))
);
INSERT INTO cloud_master_pin (account_id, setup_required) SELECT id, 0 FROM "user";
CREATE TRIGGER cloud_master_pin_new_user AFTER INSERT ON "user" BEGIN
  INSERT INTO cloud_master_pin (account_id) VALUES (NEW.id);
END;
CREATE TABLE cloud_pin_reset (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES cloud_device(id) ON DELETE CASCADE,
  profile_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'consumed')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX cloud_pin_reset_account ON cloud_pin_reset(account_id, expires_at);
