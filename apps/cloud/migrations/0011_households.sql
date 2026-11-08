-- Cloud identities may own several households. Earlier account namespaces and
-- PIN records remain archived; this migration only adds household namespaces.
CREATE TABLE cloud_household (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  server_id TEXT NOT NULL,
  ownership_version INTEGER NOT NULL DEFAULT 1,
  merged_into TEXT REFERENCES cloud_household(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cloud_household_owner ON cloud_household(account_id);

INSERT OR IGNORE INTO cloud_household (id, account_id, name, server_id, created_at, updated_at)
SELECT dataset_id, account_id, 'Household', dataset_id, updated_at, updated_at
FROM cloud_encrypted_checkpoint WHERE dataset_id IS NOT NULL;
INSERT INTO cloud_household (id, account_id, name, server_id, created_at, updated_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  u.id, 'Household', 'migrated', 0, 0
FROM "user" u WHERE EXISTS (SELECT 1 FROM cloud_profile p WHERE p.account_id = u.id)
AND NOT EXISTS (SELECT 1 FROM cloud_household h WHERE h.account_id = u.id);

ALTER TABLE cloud_device ADD COLUMN household_id TEXT REFERENCES cloud_household(id) ON DELETE SET NULL;
ALTER TABLE cloud_device_grant ADD COLUMN household_id TEXT;
ALTER TABLE cloud_device_grant ADD COLUMN household_name TEXT;
ALTER TABLE cloud_device_grant ADD COLUMN server_id TEXT;
UPDATE cloud_device SET household_id = (SELECT id FROM cloud_household h WHERE h.account_id = cloud_device.account_id LIMIT 1);

CREATE TABLE cloud_household_sync_profile (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES cloud_household(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  updated_at TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX cloud_household_sync_profile_owner ON cloud_household_sync_profile(account_id, active);
CREATE TRIGGER cloud_household_sync_profile_owner BEFORE INSERT ON cloud_household_sync_profile
WHEN EXISTS (SELECT 1 FROM cloud_household_sync_profile WHERE id = NEW.id AND account_id <> NEW.account_id)
BEGIN SELECT RAISE(ABORT, 'profile_not_owned'); END;
CREATE TRIGGER cloud_household_sync_profile_cap BEFORE INSERT ON cloud_household_sync_profile
WHEN NEW.active = 1 AND NOT EXISTS(SELECT 1 FROM cloud_household_sync_profile WHERE id = NEW.id)
AND (SELECT COUNT(*) FROM cloud_household_sync_profile WHERE account_id = NEW.account_id AND active = 1) >= 5
BEGIN SELECT RAISE(ABORT, 'profile_limit'); END;
CREATE TRIGGER cloud_household_sync_profile_no_resurrection BEFORE INSERT ON cloud_household_sync_profile
WHEN NEW.active = 1 AND EXISTS(SELECT 1 FROM cloud_household_sync_profile WHERE id = NEW.id AND active = 0)
BEGIN SELECT RAISE(ABORT, 'profile_deleted'); END;
CREATE TRIGGER cloud_household_sync_profile_update_cap BEFORE UPDATE OF account_id, active ON cloud_household_sync_profile
WHEN NEW.active = 1 AND (OLD.account_id <> NEW.account_id OR OLD.active = 0)
AND (SELECT COUNT(*) FROM cloud_household_sync_profile WHERE account_id = NEW.account_id AND active = 1 AND id <> NEW.id) >= 5
BEGIN SELECT RAISE(ABORT, 'profile_limit'); END;

CREATE TABLE cloud_household_sync_entity (
  account_id TEXT NOT NULL REFERENCES cloud_household(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES cloud_household_sync_profile(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('profile','library','history','progress')),
  entity_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
  updated_at TEXT NOT NULL,
  session_started_at TEXT,
  operation_json TEXT NOT NULL,
  PRIMARY KEY(account_id, profile_id, kind, entity_id)
);
CREATE TABLE cloud_household_sync_account_entity (
  account_id TEXT NOT NULL REFERENCES cloud_household(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind = 'source-feedback'),
  entity_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
  updated_at TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  PRIMARY KEY(account_id, kind, entity_id)
);
CREATE TABLE cloud_household_sync_operation_receipt (
  account_id TEXT NOT NULL REFERENCES cloud_household(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, operation_id)
);
CREATE TRIGGER cloud_household_sync_receipt_immutable BEFORE INSERT ON cloud_household_sync_operation_receipt
WHEN EXISTS (SELECT 1 FROM cloud_household_sync_operation_receipt WHERE account_id = NEW.account_id AND operation_id = NEW.operation_id AND operation_hash <> NEW.operation_hash)
BEGIN SELECT RAISE(ABORT, 'operation_id_conflict'); END;
CREATE TABLE cloud_household_sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES cloud_household(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, operation_id)
);
CREATE INDEX cloud_household_sync_log_owner ON cloud_household_sync_log(account_id, seq);
CREATE TABLE cloud_household_sync_retention (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES cloud_household(id) ON DELETE CASCADE,
  pruned_through INTEGER NOT NULL
);
CREATE TABLE cloud_household_checkpoint (
  household_id TEXT PRIMARY KEY NOT NULL REFERENCES cloud_household(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  dataset_id TEXT NOT NULL,
  envelope_json TEXT,
  invalidated_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE cloud_household_request (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ownership-transfer','profile-transfer','merge')),
  source_household_id TEXT NOT NULL REFERENCES cloud_household(id) ON DELETE CASCADE,
  target_household_id TEXT REFERENCES cloud_household(id) ON DELETE CASCADE,
  source_account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  profile_id TEXT,
  source_version INTEGER NOT NULL,
  target_version INTEGER,
  snapshot_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
  accept_nonce TEXT,
  approved_at INTEGER,
  source_revision INTEGER,
  target_revision INTEGER,
  source_cursor INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX cloud_household_request_owner ON cloud_household_request(target_account_id, status, expires_at);
CREATE TABLE cloud_household_reset (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES cloud_household(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES cloud_device(id) ON DELETE CASCADE,
  profile_name TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('master-pin','profile-pin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','consumed')),
  expires_at INTEGER NOT NULL
);
CREATE TRIGGER cloud_household_before_delete BEFORE DELETE ON cloud_household
BEGIN UPDATE cloud_device SET revoked_at = COALESCE(revoked_at, CAST(unixepoch('now') AS INTEGER)*1000) WHERE household_id = OLD.id; END;

INSERT INTO cloud_household_sync_profile SELECT p.id,h.id,p.active,p.updated_at,p.operation_id,p.ownership_epoch FROM cloud_profile p JOIN cloud_household h ON h.account_id = p.account_id;
INSERT INTO cloud_household_sync_entity SELECT h.id,e.profile_id,e.kind,e.entity_id,e.operation_id,e.action,e.updated_at,e.session_started_at,e.operation_json FROM cloud_entity e JOIN cloud_household h ON h.account_id = e.account_id;
INSERT INTO cloud_household_sync_account_entity SELECT h.id,e.kind,e.entity_id,e.operation_id,e.action,e.updated_at,e.operation_json FROM cloud_account_entity e JOIN cloud_household h ON h.account_id = e.account_id;
INSERT INTO cloud_household_sync_log SELECT l.seq,h.id,l.profile_id,l.kind,l.action,l.operation_id,l.operation_json,l.created_at FROM cloud_sync_log l JOIN cloud_household h ON h.account_id = l.account_id;
INSERT INTO cloud_household_sync_operation_receipt SELECT h.id,r.operation_id,r.operation_hash,r.created_at FROM cloud_operation_receipt r JOIN cloud_household h ON h.account_id = r.account_id;
INSERT INTO cloud_household_sync_retention SELECT h.id,r.pruned_through FROM cloud_sync_retention r JOIN cloud_household h ON h.account_id = r.account_id;
INSERT INTO cloud_household_checkpoint (household_id,revision,dataset_id,envelope_json,updated_at) SELECT h.id,c.revision,h.id,c.envelope_json,c.updated_at FROM cloud_encrypted_checkpoint c JOIN cloud_household h ON h.account_id = c.account_id;

CREATE TRIGGER cloud_household_entity_owner BEFORE INSERT ON cloud_household_sync_entity
WHEN NOT EXISTS (SELECT 1 FROM cloud_household_sync_profile WHERE id = NEW.profile_id AND account_id = NEW.account_id AND (active = 1 OR (NEW.kind = 'profile' AND NEW.action = 'delete')))
AND NOT (NEW.kind = 'profile' AND NEW.action = 'delete' AND EXISTS (SELECT 1 FROM cloud_household_request WHERE kind IN ('profile-transfer','merge') AND source_household_id = NEW.account_id AND status = 'approved' AND (profile_id = NEW.profile_id OR kind = 'merge')))
BEGIN SELECT RAISE(ABORT, 'profile_not_owned'); END;
CREATE TRIGGER cloud_household_feedback_profile_insert BEFORE INSERT ON cloud_household_sync_account_entity
WHEN NEW.action = 'upsert' AND (json_type(NEW.operation_json, '$.payload.profileId') IS NOT 'text'
OR NOT EXISTS (SELECT 1 FROM cloud_household_sync_profile WHERE id = json_extract(NEW.operation_json, '$.payload.profileId') AND account_id = NEW.account_id))
BEGIN SELECT RAISE(ABORT, 'profile_not_owned'); END;
