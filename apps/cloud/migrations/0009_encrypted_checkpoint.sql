-- Opaque client-encrypted recovery checkpoints. The Worker never receives keys.
-- A deleted row remains as a revision tombstone and disables legacy plaintext
-- writes for this account, so an offline old server cannot resurrect its data.
CREATE TABLE cloud_encrypted_checkpoint (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  dataset_id TEXT,
  envelope_json TEXT,
  updated_at INTEGER NOT NULL
);

-- Legacy account merges cannot decrypt/re-encrypt households. Fail atomically
-- rather than cascading away one household or silently combining ownership.
CREATE TRIGGER cloud_encrypted_checkpoint_merge_guard
BEFORE UPDATE OF accept_nonce ON cloud_account_merge
WHEN NEW.accept_nonce IS NOT NULL AND OLD.accepted_at IS NULL AND EXISTS (
  SELECT 1 FROM cloud_encrypted_checkpoint
  WHERE account_id IN (NEW.source_account_id, NEW.target_account_id)
)
BEGIN SELECT RAISE(ABORT, 'merge_changed'); END;
