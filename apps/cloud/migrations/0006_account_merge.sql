ALTER TABLE cloud_device ADD COLUMN merged_from_account_id TEXT;
ALTER TABLE cloud_device ADD COLUMN merge_ack_required INTEGER NOT NULL DEFAULT 0 CHECK(merge_ack_required IN (0, 1));

CREATE TABLE cloud_account_merge_alias (
  source_id TEXT PRIMARY KEY NOT NULL,
  target_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX cloud_account_merge_alias_target ON cloud_account_merge_alias(target_id);

-- These are copies of deletion notices previously visible to this device's
-- original account, never cloud entities or authority over another profile.
CREATE TABLE cloud_merge_device_tombstone (
  device_id TEXT NOT NULL REFERENCES cloud_device(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  PRIMARY KEY (device_id, profile_id)
);

CREATE TABLE cloud_account_merge (
  id TEXT PRIMARY KEY NOT NULL,
  source_account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  target_account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  approver_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accept_nonce TEXT,
  source_cursor INTEGER,
  target_cursor INTEGER,
  profile_ids_json TEXT,
  seen_profile_ids_json TEXT,
  source_profile_ids_json TEXT
);
CREATE INDEX cloud_account_merge_approver ON cloud_account_merge(approver_id, expires_at);
CREATE INDEX cloud_account_merge_requester ON cloud_account_merge(requested_by, expires_at);

CREATE TRIGGER cloud_account_merge_guard BEFORE UPDATE OF accept_nonce ON cloud_account_merge
WHEN NEW.accept_nonce IS NOT NULL AND OLD.accepted_at IS NULL AND (
  NEW.source_cursor <> MAX(
    (SELECT COALESCE(MAX(seq), 0) FROM cloud_sync_log WHERE account_id = NEW.source_account_id),
    COALESCE((SELECT pruned_through FROM cloud_sync_retention WHERE account_id = NEW.source_account_id), 0))
  OR NEW.target_cursor <> MAX(
    (SELECT COALESCE(MAX(seq), 0) FROM cloud_sync_log WHERE account_id = NEW.target_account_id),
    COALESCE((SELECT pruned_through FROM cloud_sync_retention WHERE account_id = NEW.target_account_id), 0))
  OR EXISTS (SELECT 1 FROM cloud_email_login WHERE user_id = NEW.source_account_id)
  OR NOT EXISTS (SELECT 1 FROM account WHERE userId = NEW.source_account_id AND providerId = 'google')
  OR EXISTS (SELECT 1 FROM cloud_profile p WHERE p.active = 1
    AND p.account_id IN (NEW.source_account_id, NEW.target_account_id)
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.seen_profile_ids_json) j WHERE j.value = p.id))
  OR EXISTS (SELECT 1 FROM json_each(NEW.seen_profile_ids_json) j WHERE NOT EXISTS (
    SELECT 1 FROM cloud_profile p WHERE p.id = j.value AND p.active = 1
      AND p.account_id IN (NEW.source_account_id, NEW.target_account_id)))
  OR EXISTS (SELECT 1 FROM json_each(NEW.profile_ids_json) j WHERE NOT EXISTS (
    SELECT 1 FROM cloud_profile p WHERE p.id = j.value AND p.active = 1
      AND p.account_id IN (NEW.source_account_id, NEW.target_account_id)))
)
BEGIN SELECT RAISE(ABORT, 'merge_changed'); END;
