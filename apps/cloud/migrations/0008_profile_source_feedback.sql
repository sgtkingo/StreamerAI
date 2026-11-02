-- Existing feedback has no profile identity and cannot be attributed reliably.
-- Advance the retention floor so clients behind removed log entries resnapshot.
INSERT INTO cloud_sync_retention (account_id, pruned_through)
SELECT account_id, MAX(seq) FROM cloud_sync_log
WHERE kind = 'source-feedback' GROUP BY account_id
ON CONFLICT(account_id) DO UPDATE SET
  pruned_through = MAX(cloud_sync_retention.pruned_through, excluded.pruned_through);

DELETE FROM cloud_sync_log WHERE kind = 'source-feedback';
DELETE FROM cloud_account_entity WHERE kind = 'source-feedback';

-- Reject writes from older Workers during a rolling deployment. Such writes
-- cannot be attributed and would make updated clients fail to parse snapshots.
CREATE TRIGGER IF NOT EXISTS cloud_feedback_profile_insert BEFORE INSERT ON cloud_account_entity
WHEN NEW.kind = 'source-feedback' AND NEW.action = 'upsert'
  AND json_type(NEW.operation_json, '$.payload.profileId') IS NOT 'text'
BEGIN SELECT RAISE(ABORT, 'feedback_profile_required'); END;

CREATE TRIGGER IF NOT EXISTS cloud_feedback_profile_update BEFORE UPDATE ON cloud_account_entity
WHEN NEW.kind = 'source-feedback' AND NEW.action = 'upsert'
  AND json_type(NEW.operation_json, '$.payload.profileId') IS NOT 'text'
BEGIN SELECT RAISE(ABORT, 'feedback_profile_required'); END;
