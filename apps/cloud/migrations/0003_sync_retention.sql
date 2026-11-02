-- The floor survives pruning the final log row for an account.
CREATE TABLE cloud_sync_retention (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  pruned_through INTEGER NOT NULL DEFAULT 0 CHECK(pruned_through >= 0)
);

ALTER TABLE cloud_operation_receipt ADD COLUMN created_at INTEGER;
-- Existing receipts have no reliable creation time. Start their retention window
-- at migration time instead of treating unknown ages as immediately expired.
UPDATE cloud_operation_receipt
SET created_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
-- The previous Worker can still insert receipts while the new deployment rolls
-- out. Give those inserts an age too; the new Worker supplies its timestamp.
CREATE TRIGGER cloud_operation_receipt_default_created_at
AFTER INSERT ON cloud_operation_receipt WHEN NEW.created_at IS NULL
BEGIN
  UPDATE cloud_operation_receipt
  SET created_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
  WHERE account_id = NEW.account_id AND operation_id = NEW.operation_id;
END;
CREATE INDEX cloud_operation_receipt_age ON cloud_operation_receipt(created_at);
CREATE INDEX cloud_sync_log_age ON cloud_sync_log(created_at);

DROP TRIGGER cloud_transfer_guard;
CREATE TRIGGER cloud_transfer_guard BEFORE UPDATE OF accept_nonce ON cloud_transfer
WHEN NEW.accept_nonce IS NOT NULL AND OLD.accepted_at IS NULL AND (
  NOT EXISTS(SELECT 1 FROM cloud_profile p WHERE p.id = NEW.profile_id
    AND p.account_id = NEW.source_account_id AND p.active = 1 AND p.ownership_epoch = NEW.ownership_epoch)
  OR NEW.source_cursor <> MAX(
    (SELECT COALESCE(MAX(seq), 0) FROM cloud_sync_log WHERE account_id = NEW.source_account_id),
    COALESCE((SELECT pruned_through FROM cloud_sync_retention WHERE account_id = NEW.source_account_id), 0))
  OR NEW.target_cursor <> MAX(
    (SELECT COALESCE(MAX(seq), 0) FROM cloud_sync_log WHERE account_id = NEW.target_account_id),
    COALESCE((SELECT pruned_through FROM cloud_sync_retention WHERE account_id = NEW.target_account_id), 0))
)
BEGIN SELECT RAISE(ABORT, 'transfer_changed'); END;
