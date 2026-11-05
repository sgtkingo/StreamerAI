# Encrypted household recovery, format v1

Implementation status: local encrypted household export, preview, recovery and
replacement recovery keys are available through the paired server owner's API.
An optional opaque Worker/D1 checkpoint transport is implemented in source. It
requires cloud migration `0009_encrypted_checkpoint.sql` and a separately released
Worker; this change does not deploy a Worker or upload user data.

This is an initial recovery format, not the completed multi-server replication
protocol from deploy-plan section 5A. The API reports
`automaticMergeAvailable: false` and `approvalAvailable: false`. Account-portal
approval and key exchange remain unavailable until an existing authenticated
exchange protocol has been selected, reviewed and tested. An online account
alone cannot decrypt these exports.

## Data included

The versioned decrypted schema registers whole profile preference records
(including private taste prompts), locale/name, portable salted PIN verification
records, media provider order, integration enablement, library membership,
complete watch history, playback positions, account-owned source feedback and
the minimum title metadata needed to recover those records. Account-owned source
feedback is preserved even when its author profile was removed.

Only the existing explicit provider credential allowlist is exported: TMDB read
token, Webshare WST, Hellspy session and supported remote inference API keys.
Installation, account-cloud and session credentials cannot be selected through
this format. Provider-side expiration, device binding and refresh limitations
still apply; import is offline and does not claim to have validated a provider.
Restored integrations are marked `RESTORED_UNVERIFIED` and are checked when used.

Every preview lists the omissions: discovery conversations, custom title
corrections, hashed title/source choices, local paths and inference configuration.
Caches, media files, models, audio output device IDs, paired clients, server
identity and the local vault/master key are excluded. Use the separate full
offline server backup when those additional local records are required. Adding
another portable data type requires a versioned schema and a restore test.

## Cryptographic format

- Activation generates independent random 256-bit data and recovery keys using
  Node's cryptographic random generator. The printable recovery key is
  `STRM-R1-` followed by the base64url-encoded random key. Format v1 accepts no
  user-chosen passwords or weak passphrases.
- Node/OpenSSL AES-256-GCM encrypts the payload with a fresh random 96-bit nonce
  and a 128-bit authentication tag. No plaintext is parsed before tag checking.
- Associated data binds the format version, dataset UUID, data-key version,
  recovery version, purpose, snapshot UUID, monotonically reserved local
  sequence and creation time. The recovery wrapper uses a distinct purpose and
  its own nonce to encrypt the data key.
- The recovery secret is returned once to the owner. It is not stored by the
  service, included in an export or sent to the Worker. The local data key is
  kept through the existing encrypted secret-store boundary; production
  composition requires a persistent encrypted vault.
- A replacement recovery key produces a new authenticated wrapper. **This does
  not revoke an old export or a data key already recovered from one.** A
  compromise needs data-key rotation and new backups; data-key rotation is not
  implemented by the recovery-wrapper replacement operation.

The primitive/API choices follow [Node's authenticated encryption
documentation](https://nodejs.org/api/crypto.html). This protocol still requires
the independent security review and cross-platform acceptance in the deploy
plan before a public release. It is not claimed to be externally audited.

## Import behavior

An owner supplies the encrypted envelope and recovery key to the destination
server, reviews the safe preview and explicitly confirms recovery into the
empty household. A strictly unused first-run `Viewer` placeholder can be replaced;
a configured profile, existing credentials or conflicting profile sync IDs
cause rejection. Existing households are never merged or overwritten by this
operation. Each imported profile gets a fresh installation-local ID while
retaining its logical sync ID; clients must pair with the destination server.

Import authenticates and validates the complete payload before writing. Vault
writes are journaled using secret key *names*, without plaintext credentials.
Database records and the commit marker are installed in one SQLite transaction.
Failures compensate incomplete vault writes; a retry recovers an interrupted
import's journal. Repeating the same committed snapshot is idempotent.

Export reads a consistent SQLite transaction between two equal credential
captures, refusing a credential change during that interval. It is a portable
household checkpoint, not the complete consistent server-image backup used by
the independent offline backup tool.

## Optional opaque cloud checkpoints

`GET`, `PUT` and `DELETE /v1/sync/v2/checkpoint` use existing cloud authentication.
Only a server device token can write/delete; browser account sessions may read
the opaque envelope. New checkpoint writes use an explicit `expectedRevision`.
The conditional SQLite write either advances that revision or returns a
conflict; concurrent writers do not silently overwrite each other.

Deletion retains a revision tombstone. Local activation/import pauses legacy
plaintext sync, and the server's legacy engine refuses to capture/send an E2EE
household. Once a cloud checkpoint exists, the Worker also rejects legacy
plaintext pushes, including after deletion. Legacy account merges are refused
for these datasets because they cannot decrypt or reconcile household keys.

The cloud envelope is capped at 1,800,000 bytes, leaving margin below [D1's
2,000,000-byte row limit](https://developers.cloudflare.com/d1/platform/limits/).
Larger households can still use the local file format up to its 16 MiB envelope
limit; the cloud API reports a size error. Cloud requests contain ciphertext,
the recovery-wrapped data key and minimum version/identity/time/size metadata.
The Worker does not know the decryption keys or parse decrypted profile data.

The local/cloud checkpoint buttons are explicit operations. Automatic schedules,
immutable operation/outbox replication, authenticated remote rollback tracking,
credential conflict reconciliation, key revocation/rotation and deletion of
previous plaintext cloud copies remain release gates. Existing plaintext copies
and storage-provider backups do not disappear when encryption is activated.

## API integration and verification

Routes are under `/api/v1/account/encrypted-household`. Every route requires the
paired installation owner's session and returns `Cache-Control: no-store`.
Activation, restore, key replacement and remote writes/deletion require explicit
confirmation values. Browser requests must pass the installation/account origin
checks. Secrets and decrypted snapshots are excluded from error responses.

Tests cover fresh-vault recovery through both the service and actual paired
`createApp`, PIN/library/history/progress/feedback preservation, opaque output,
wrong keys, authenticated-header/ciphertext tampering, independent old backups,
fresh nonces, overwrite refusal, interrupted-vault compensation, idempotency,
owner/viewer authorization, cloud account isolation, revision conflicts,
deletion tombstones, legacy sync/merge refusal and explicit account deletion.
