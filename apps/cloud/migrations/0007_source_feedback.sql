-- Account feedback is independent of profile ownership and profile deletion.
CREATE TABLE cloud_account_entity (
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind = 'source-feedback'),
  entity_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('upsert', 'delete')),
  updated_at TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  PRIMARY KEY(account_id, kind, entity_id)
);
