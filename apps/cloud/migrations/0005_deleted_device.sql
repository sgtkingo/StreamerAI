-- A one-way device-token fingerprint is retained without account identity so
-- an offline home server can distinguish account deletion from revocation.
CREATE TABLE cloud_deleted_device (
  token_hash TEXT PRIMARY KEY NOT NULL,
  deleted_at INTEGER NOT NULL
);
