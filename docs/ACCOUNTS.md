# Accounts, profiles and synchronization

The home server runs the web application, search, provider connectors and
playback. Google/e-mail identity and the optional user-state replica run on a
Cloudflare Worker with an EU D1 database. AI is optional. A future native
Android client can use the same local API and device authorization flow.

Explicit local entry, optional sync and StreamerAI e-mail codes through Brevo
are implemented. The [account modes and e-mail/Drive plan](ACCOUNT_MODES_PLAN.md)
tracks the remaining Google Drive work; Drive is not an available sync provider
yet.

## Enable accounts

Deploy the identity service as described in [CLOUD_AUTH.md](CLOUD_AUTH.md), then
set these non-secret values in the home server's `.env` and restart it:

```dotenv
STREAMERAI_ACCOUNT_SERVICE_URL=https://cloud.streamer-ai.workers.dev
STREAMERAI_WEB_ORIGIN=http://localhost:5173
```

For Compose use the actual web origin, normally `http://localhost:8080`.
For a TV use the home server's LAN hostname/address as the web origin.
The web server proxies `/api` to Fastify; Google callbacks always return to
the public Worker, never to a private LAN address. Keep the home server on
the private network or behind a VPN. Public hosting of playback is outside
this deployment's scope.

An empty account-service URL keeps the existing trusted local mode. That mode
does not authenticate a household administrator; anyone able to reach its
API is trusted. Existing signed-in cloud sessions can keep using local data
during a cloud outage until their 30-day expiry. New sign-in and online PIN
recovery need connectivity. Confirmed device revocation is checked at most
once per minute while the cloud is reachable.

## Sign in and pair a TV

Choose **Sign in to StreamerAI** on the home application. It displays a QR code
and an eight-character code. On a phone, open the QR address, sign in with
Google or an e-mail code, compare the displayed code/device name and explicitly approve it.
Alternatively enter the code at the Worker's `/device` page. Codes expire
after five minutes and are single-use. The home browser polls using a
browser-bound request; the cloud bearer credential stays in the local
encrypted vault. The browser receives an HttpOnly local session cookie.

The same flow handles desktop, TV and a future Android client. A TV browser
connected to the same home server reads the same local database immediately;
cloud synchronization connects separate home installations. Browser owner
sessions on the hosted portal and device credentials have different powers:
only an owner browser session can approve pairing or transfer profiles.

Google and e-mail codes are implemented. Apple remains deferred.

## Local entry and optional synchronization

Choose **Continue locally** to open the local household without registration.
It issues a revocable HttpOnly session and keeps the same server-side profile
and PIN checks. It does not contact the identity service. If the old `local`
account already belongs to a verified online owner, a distinct household
account is used; private profiles and provider credentials are never copied.

After explicit local entry, an ordinary online sign-in opens a separate
account. To connect the household itself, use Account settings, review its
profile names, explicitly select the online owner and confirm pairing.
The household keeps its profiles/PINs/connections; other local sessions are
revoked. If that online identity already has a different account on this home
server, stop and review/import separately rather than silently merging them.

The welcome page can disable synchronization before pairing. Account settings
also enable/disable sync independently of login. Pausing retains data, the
remote copy and durable pending changes. In-flight responses are discarded
after pausing; resuming sends the queued changes. A paused online account still
uses its regular identity/device session expiry and owner verification.

The Cloud sync card can also pause one profile on this installation. Both
outgoing and incoming changes for that profile wait durably until it is
resumed; other profiles continue syncing. A batch already in flight finishes
before the pause is confirmed. Deferred changes are applied and queued changes
are sent after resuming, using the usual conflict resolution rules. This
setting is installation-specific, not a cloud-wide pause.

After confirmed deletion of the online account, an updated home server clears
the cloud association and sync state while retaining its local profiles and
other local data. The current local session can then explicitly pair with a
new online account. A device revocation or temporary cloud outage alone never
triggers conversion. If another local household exists, Continue locally lets
the user select a converted household without merging their data. Devices whose tokens were already removed
by an older worker's retention task also cannot receive the deletion signal.

## Source correctness feedback

For the proposed next steps toward shared community feedback, see
[Community database plan](COMMUNITY_DB_PLAN.md).

Small thumbs beside a title's individual files record whether that file is
the correct film or episode. A selected thumb glows green/red; pressing it
again clears the vote. Each profile has one current vote for each
title/provider/file/episode assignment. Counts are shared across the account,
while the glowing thumb shows the current profile's vote. Sources are ranked
by the sum of positive and negative profile votes. The normal
compatibility filters and live playback checks still apply.

Settings → Sources → Stream sources includes **Source correctness feedback**,
enabled by default for each profile. Turning it off hides the thumbs, rejects
new votes from that profile and ignores account votes in that profile's source
ranking. Saved account votes remain available to other profiles. This profile
preference follows normal profile synchronization; account votes follow account
synchronization independently of profile sync pauses.

Sync sends only the profile's sync ID, canonical title ID, provider ID, opaque file candidate ID,
season/episode coordinates, vote and conflict-resolution timestamp/operation ID.
It does not send release names, media links or credentials. Clearing a vote is
replicated as a neutral record so an offline device cannot restore an older
thumb. Account votes survive profile deletion and stay with the account when a
profile is transferred. Explicit account merging combines votes using the same
latest-change conflict resolution. They are private account data; no community
lookup or aggregation is implemented.

Deploy D1 migrations `0007_source_feedback.sql` and `0008_profile_source_feedback.sql` and the updated Worker before
enabling sync on updated home servers. All syncing home servers should use this
release together: older clients do not understand the new operation kind or
the third snapshot phase. Local database migration 12 runs at startup. Migration
12 and D1 migration 0008 discard old account-level feedback because it cannot
be attributed to a profile; other synchronized state is retained. All syncing
home servers must be updated to the profile-vote version.

## E-mail codes and identity linking

The hosted login page sends an eight-digit code through Brevo. It expires after
ten minutes, is single-use, and permits five verification attempts. Stored
codes are keyed hashes, never plaintext. Resends rotate the code and have a
shared sixty-second cooldown. Persistent budgets limit requests per recipient,
source IP and globally; transport failures return a neutral error without
leaking the provider response or showing a false delivery success.

An existing Google owner first signs in through Google, opens the hosted
account portal, chooses **Zapnout přihlášení e-mailem**, and verifies a code
sent to that account's registered address. This requires a browser login less
than five minutes old and preserves the same user/profiles. A public request
for an unlinked Google address gets a neutral response. New e-mail-only users
can register through their code; they can explicitly link Google from a fresh
portal session. Matching e-mail text never implicitly merges two identities.

**Settings → Connected accounts** shows e-mail/Google enrollment and the
planned Apple provider. Linking opens the hosted account portal and preserves
the current owner ID. If that browser is signed in as another owner, linking
stops until the correct owner signs in. Returning to Settings refreshes the
list. The read-only connection list contains no OAuth identifiers or tokens;
device credentials cannot enroll or link a sign-in method. Existing independent
accounts are not automatically merged.

## Accounts and migration

Each account owns up to five profiles. Each profile has its own preferences,
Library, History and playback progress. Connected media/metadata services and
their encrypted credentials are shared by the account's profiles on that
installation. New-profile onboarding recognizes these connections.

Before upgrading an existing on-disk pre-account database, the application
creates and verifies a sibling `*.pre-accounts-<timestamp>-<uuid>.db` backup.
Failure to create or verify it stops the migration. Fresh and already migrated
databases do not get another migration backup. Back up the encrypted vault and
its separate master key too; the SQLite backup does not include them.

All legacy profiles are assigned to the installation's `local` account.
The **first-created profile's** connection configuration and credentials
become the account connections. Missing credentials are not borrowed from a
different profile. Original encrypted entries are retained for rollback and
are ignored after migration, including after disconnecting a service.

The first verified online account claims that legacy account once, unless the
household has explicitly chosen local entry. Subsequent online accounts get
separate accounts and profiles. Claim the installation
with the intended owner before letting another household member sign in.
The stable local account ID can remain `local` after it has been linked to
Google; that ID does not mean it is unauthenticated.

## Profile PIN

A profile can have a 4–8 digit PIN. Its salted scrypt verifier stays in the
home database. Five incorrect attempts lock verification for five minutes.
An unlock belongs to the local browser session, expires after 30 minutes of
profile inactivity and is invalidated when the PIN changes, the profile is
explicitly locked or the server restarts. Protected profile routes enforce
the lock on the server; hiding UI alone does not grant access.

Changing/removing a PIN requires the current PIN. **Forgot PIN? Verify
account** creates an explicit recovery request, requires a recent online
owner login and grants five minutes to reset that profile on that browser.
Approving with another online account cannot reset it. Recovery does not
replace the signed-in account or store another reusable cloud credential.

PINs are enforced by the home installation and shared by all its web/TV
clients. Their verifiers are not synchronized to another installation.
Set a PIN separately there. PINs protect household profile access; they do
not restrict the server's OS/database administrator. Local-only mode has no
Google recovery, so keep the PIN or restore a known database backup.

## Synchronized state

The versioned `/v1/sync` protocol allowlists profile display/preferences,
Library membership, History, playback progress and account source correctness
feedback. It includes only small title descriptors for titles actually
referenced by that data, plus opaque provider/file IDs in feedback. It excludes
provider tokens, PIN verifiers, raw taste/AI prompts, local paths, output
device IDs, media URLs/files, posters and a complete catalog mirror.

Local mutations set a durable dirty journal in the same SQLite transaction.
Capture atomically saves the ledger/outbox and clears that journal. A crash
before the HTTP response does not lose pending user state. The worker checks
account ownership, the five-profile cap, immutable operation IDs and strict
payloads. The home server syncs once a minute or through **My account → Sync
now**. Offline requests keep their outbox for retry with bounded exponential
backoff and jitter. Playback never waits for sync.

Operations merge by UTC timestamp and operation ID. Playback progress also
compares playback-session start times so a deliberate restart can replace
an older, higher position. Tombstones prevent deleted or transferred profiles
from reappearing after an offline device reconnects. Initial imports use a
paginated snapshot followed by deltas. A genuinely empty bootstrap Viewer
is replaced by existing cloud profiles; existing personal profiles are kept.
If merging installations would exceed five profiles, free a slot explicitly.

The owner-approved retention policy removes sync logs and operation receipts
strictly older than 90 days during six-hour maintenance. It keeps all current
user state and durable deletion/ownership tombstones. A long-offline client
with an expired cursor automatically obtains a fresh snapshot while preserving
its local ledger and pending offline changes. An expired 30-day device login
still requires signing in again before synchronization can resume.

## Transfer a profile

Synchronize the source installation, then open **My account → Manage account
online**, or the Worker's `/account`. Select the profile and the existing
target account's verified e-mail or UID. The target owner signs in to that portal
and accepts or declines within 24 hours. If the destination already has five
profiles, the owner chooses which profiles remain. Profiles excluded from that
selection are deleted from cloud sync and synchronized installations.

The transfer moves synchronized preferences, Library, History and progress.
It removes source ownership and is imported on the next synchronization.
The target profile needs a new local PIN. Provider credentials stay with the
source account/installation and the target uses its own connected services.
Raw local prompts and device-specific settings are not part of the transfer.

## Merge online accounts

The online account page displays the account UID and offers a merge request by
verified e-mail or UID. Both owners must use freshly authenticated browser
sessions. The recipient sees the profiles from both accounts and explicitly
chooses at most five to keep; the others are deleted from cloud sync and
synchronized installations. The existing e-mail sign-in account's UID is
preserved when exactly one has e-mail sign-in; otherwise the requester's UID
survives. Google identities and device credentials move to the surviving account.
Merging two accounts that each have separate active e-mail sign-ins is currently
blocked to avoid silently losing one of those sign-in methods.

Updated home installations verify the merge with the worker and switch to a
fresh sync snapshot; worker-side synchronization is blocked for merged devices
until they acknowledge the change. If the surviving online account is already
attached to a separate local account on the same installation, synchronization
is blocked on the former account to preserve both local households for review.
Sign out, pair with the surviving account and synchronize it to import the
chosen profiles. Unsynchronized changes on the former account are not copied;
provider credentials remain separate and may need to be reconnected. Update the
home server before completing a merge; older servers cannot acknowledge the new
UID.

When delivery is configured, a verified recipient receives signed, one-use
e-mail links to accept or decline without signing in. The links are bound to the
request, decision, recipient and verified address, and expire with the request.
Opening a link performs that decision, including when an e-mail scanner opens
it. If accepting would exceed five profiles, the link opens a selection form
without requiring a login. Requests remain in the portal if delivery fails.

## Local HTTP surface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/auth/status` | Local account session/configuration |
| `POST /api/v1/auth/local` | Open the isolated local household session |
| `POST /api/v1/auth/device` | Start login or explicit PIN recovery |
| `POST /api/v1/auth/device/poll` | Redeem the browser-bound pairing |
| `POST /api/v1/auth/logout` | Revoke this local session/device |
| `GET /api/v1/account` | Account, local devices, cloud portal and sync state |
| `GET /api/v1/account/connections` | Sanitized enrollment state for this owner's sign-in methods |
| `POST /api/v1/account/sync` | Synchronize this account |
| `PUT /api/v1/account/sync` | Enable/pause sync without deleting data |
| `DELETE /api/v1/account/devices/:deviceId` | Revoke a local device session |
| `PUT /api/v1/profiles/:profileId/pin` | Set/change/remove PIN |
| `POST /api/v1/profiles/:profileId/unlock` | Verify PIN for this browser |
| `POST /api/v1/profiles/:profileId/lock` | Relock this browser |

The online portal lists devices from all installations. The local account
page lists sessions known to that home server. Remote revocation requires
cloud connectivity; local logout/revocation still takes effect immediately.

## Acceptance checks

Automated tests cover legacy migration/backup, account isolation, shared
credentials, PIN guessing/change/recovery, browser-bound pairing, device
revocation, offline restart, multi-installation replication, deletion,
progress resets, transfer ownership and strict cloud payload rejection.

Before household rollout, perform one real Google login, pair the actual TV,
and use two real Google test accounts to transfer a profile. On a second home
installation verify Library/History/resume position, disconnect the network,
make changes, reconnect and confirm convergence. Google projects in Testing
must explicitly allow both test users. Never simulate a production owner
by inserting a user or session directly into D1.

## Pilot verification — 2026-11-01

- 778 automated tests pass across contracts, database, server, cloud and web;
  13 opt-in FFmpeg/Ollama integration tests remain skipped.
- Typechecks, ESLint and production builds pass. Worker bundle is about
  425 KiB gzip and deployed successfully on Workers Free.
- Live Worker/D1 checks pass for health, hosted login/security headers,
  anonymous access rejection, Google OAuth initiation with PKCE, actual local
  API pairing/QR creation, browser binding and pending-token polling.
- Copies of both existing development databases migrated successfully,
  preserving their profiles. The running home server subsequently created a
  verified pre-account backup and migrated its own database successfully.
- The local application runs at `http://localhost:5173`; the API reports ready
  and cloud accounts enabled, with anonymous profile access returning 401.
- Full repository formatting still fails on 12 existing files. Checking their
  `HEAD` versions confirmed the formatting issues predate this implementation.
  Account/sync additions are formatted; unrelated files and the user's
  existing `docs/TODO.md` edits were preserved.

The owner confirmed real Google consent/callback to the hosted `/account`
portal and successful pairing of the home application on 2026-11-01. Live D1
also contains the real account/session and synchronized user-state entities.
The actual TV browser and profile transfer between two real Google accounts
remain manual acceptance checks. No production owner/session was fabricated.

Retention tests also exercise the actual Worker protocol with two local
databases: after 91 days and fresh device authorization, old logs/receipts are
compacted, the returning installation receives a fresh snapshot, offline
edits and Library/History/progress survive, and a deleted profile stays gone.

The e-mail/local extension adds real Better Auth OTP tests, full email-user →
device pairing → home session → D1 integration, local household isolation and
adoption, pause/restart/resume and separate transport-binding namespace checks.
812 tests pass across the five packages after these additions (13 opt-in
FFmpeg/Ollama tests remain skipped). One existing local-media test timed out
during simultaneous full server/web runs; its isolated rerun and the complete
server suite with four workers both passed.
The added checks complete Google OAuth linking to an existing e-mail owner,
reject a mismatched portal owner, exercise offline Settings and recover after
stalled auth initialization. On 2026-11-01 the owner confirmed that the real
Brevo code arrived and activation succeeded on the existing Google account.
The live enrollment confirmation returned 200; a subsequent public e-mail-code
request also returned 200. A subsequent live trace confirmed successful
signed-out OTP sign-in and account access. The owner found the allegedly
missing sign-in messages in Spam or another folder; provider records confirmed
delivery to the same address as the activation code. Activation and sign-in
messages now have distinct, dated subjects. The hosted login shows inline
feedback and a resend countdown.
Workerd mail regression tests also cover the Workers-compatible redirect mode
and ensure a provider redirect never forwards the API key to another host.
