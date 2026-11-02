CREATE TABLE cloud_profile (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  updated_at TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX cloud_profile_owner ON cloud_profile(account_id, active);
CREATE TRIGGER cloud_profile_insert_owner BEFORE INSERT ON cloud_profile
WHEN EXISTS(SELECT 1 FROM cloud_profile WHERE id = NEW.id AND account_id <> NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'profile_not_owned'); END;
CREATE TRIGGER cloud_profile_insert_cap BEFORE INSERT ON cloud_profile
WHEN NEW.active = 1
  AND NOT EXISTS(SELECT 1 FROM cloud_profile WHERE id = NEW.id)
  AND (SELECT COUNT(*) FROM cloud_profile WHERE account_id = NEW.account_id AND active = 1) >= 5
BEGIN SELECT RAISE(ABORT, 'profile_limit'); END;
CREATE TRIGGER cloud_profile_no_resurrection BEFORE INSERT ON cloud_profile
WHEN NEW.active = 1 AND EXISTS(SELECT 1 FROM cloud_profile WHERE id = NEW.id AND active = 0)
BEGIN SELECT RAISE(ABORT, 'profile_deleted'); END;
CREATE TRIGGER cloud_profile_update_cap BEFORE UPDATE OF account_id, active ON cloud_profile
WHEN NEW.active = 1 AND (OLD.account_id <> NEW.account_id OR OLD.active = 0)
  AND (SELECT COUNT(*) FROM cloud_profile WHERE account_id = NEW.account_id AND active = 1 AND id <> NEW.id) >= 5
BEGIN SELECT RAISE(ABORT, 'profile_limit'); END;

CREATE TABLE cloud_entity (
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES cloud_profile(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('profile', 'library', 'history', 'progress')),
  entity_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert', 'delete')),
  updated_at TEXT NOT NULL,
  session_started_at TEXT,
  operation_json TEXT NOT NULL,
  PRIMARY KEY(account_id, profile_id, kind, entity_id)
);
CREATE INDEX cloud_entity_profile ON cloud_entity(profile_id);
CREATE TRIGGER cloud_entity_owner BEFORE INSERT ON cloud_entity
WHEN NOT EXISTS(SELECT 1 FROM cloud_profile p WHERE p.id = NEW.profile_id
  AND p.account_id = NEW.account_id AND (p.active = 1 OR (NEW.kind = 'profile' AND NEW.action = 'delete')))
  AND NOT (NEW.kind = 'profile' AND NEW.action = 'delete' AND EXISTS(
    SELECT 1 FROM cloud_transfer t WHERE t.profile_id = NEW.profile_id
      AND t.source_account_id = NEW.account_id AND t.accepted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'profile_not_owned'); END;

CREATE TABLE cloud_operation_receipt (
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  PRIMARY KEY(account_id, operation_id)
);
CREATE TRIGGER cloud_operation_immutable BEFORE INSERT ON cloud_operation_receipt
WHEN EXISTS(SELECT 1 FROM cloud_operation_receipt r WHERE r.account_id = NEW.account_id
  AND r.operation_id = NEW.operation_id AND r.operation_hash <> NEW.operation_hash)
BEGIN SELECT RAISE(ABORT, 'operation_id_conflict'); END;

CREATE TABLE cloud_sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, operation_id)
);
CREATE INDEX cloud_sync_log_account_cursor ON cloud_sync_log(account_id, seq);
CREATE TABLE cloud_transfer (
  id TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT NOT NULL REFERENCES cloud_profile(id) ON DELETE CASCADE,
  source_account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  ownership_epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accept_nonce TEXT,
  source_cursor INTEGER,
  target_cursor INTEGER
);
CREATE INDEX cloud_transfer_target ON cloud_transfer(target_account_id, expires_at);
CREATE INDEX cloud_transfer_source ON cloud_transfer(source_account_id, expires_at);
CREATE TRIGGER cloud_transfer_guard BEFORE UPDATE OF accept_nonce ON cloud_transfer
WHEN NEW.accept_nonce IS NOT NULL AND OLD.accepted_at IS NULL AND (
  NOT EXISTS(SELECT 1 FROM cloud_profile p WHERE p.id = NEW.profile_id
    AND p.account_id = NEW.source_account_id AND p.active = 1 AND p.ownership_epoch = NEW.ownership_epoch)
  OR NEW.source_cursor <> (SELECT COALESCE(MAX(seq), 0) FROM cloud_sync_log WHERE account_id = NEW.source_account_id)
  OR NEW.target_cursor <> (SELECT COALESCE(MAX(seq), 0) FROM cloud_sync_log WHERE account_id = NEW.target_account_id)
)
BEGIN SELECT RAISE(ABORT, 'transfer_changed'); END;
