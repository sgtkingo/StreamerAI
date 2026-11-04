# Account modes, optional sync and e-mail login preparation

> Future requirement: full end-to-end encrypted profile synchronization and
> recovery, including portable service credentials, is proposed in
> [DEPLOY_PLAN.md, section 5A](DEPLOY_PLAN.md#5a-kompletní-šifrovaná-synchronizace-a-obnova-domácnosti).
> The implementation and Drive proposal below do not yet provide this capability;
> their existing exclusion rules describe current behavior.

Status: implementation resumed on 2026-11-01. Local entry alongside online
accounts, sync pause/resume and Brevo e-mail login are implemented. The Worker
e-mail release is deployed; the owner confirmed actual code delivery and
activation on the existing Google account on 2026-11-01.
Google Drive remains planned, with a separate sync-transport interface and
binding namespaces now available for its future adapter. It is not enabled in
the application or advertised as a working choice.

Brevo preparation update: the owner reports adding the branded subdomain
`mail.7265001.xyz` and sender `no-reply@7265001.xyz`. Domain authentication,
sender verification and transactional-platform activation still need to be
confirmed by an actual delivery check. The owner disabled API IP blocking and
provided a key in the ignored local secrets folder. It is also installed as a
Worker secret. Read-only account administration calls are denied by its
permissions; an invalid recipient-free request to the send endpoint returns
input-validation 400, confirming send-resource access without sending mail.

## Requested product behavior

StreamerAI must work without registering or signing in to a StreamerAI account.
Offer three entry paths on the home installation:

| Entry path | Identity and local access | Synchronization |
| --- | --- | --- |
| Continue locally | Local household account; no e-mail or Google required | None; data stays on this home server |
| StreamerAI account | Google or e-mail code; Apple remains deferred | Optional StreamerAI cloud sync through Worker + EU D1 |
| Use my Google Drive | Local household account plus a separate Google Drive authorization; no StreamerAI registration | User-state files in that user's Drive |

All paths retain local search, playback, account-shared provider connections,
up to five profiles and optional profile PINs. AI remains optional. Clients
using the same home server already share its SQLite database and do not need
remote synchronization to see each other's changes.

Signing in, choosing a storage provider and selecting/unlocking a profile are
separate actions. A Google login to a StreamerAI account must not implicitly
grant Drive access. A Drive authorization must not create a StreamerAI cloud
account or enable D1 user-state replication. A signed-in StreamerAI owner can
also turn synchronization off while retaining local account access.

The three paths are requested requirements. Local/StreamerAI entry is
implemented; the third path needs the Drive work below. Remaining design and
release checks are tracked here rather than being presented as completed.

## Current implementation and necessary changes

- `AccountAuthService` now issues isolated local household sessions even when
  cloud accounts are configured. Existing cloud ownership is never inferred
  from the legacy `local` ID. Explicit adoption revokes old household sessions.
- `AccountLogin` and `App` offer local entry and generic StreamerAI pairing;
  the hosted portal offers Google and e-mail codes. Sync opt-out can happen
  before pairing, and Account settings provide a persistent pause/resume.
- `AccountSyncService` uses `AccountSyncTransport`; `D1AccountSyncTransport`
  owns HTTP/cursor-expiration details. Optional binding namespaces isolate
  ledger/cursor/outbox state while preserving existing D1 keys by default.
- Better Auth's e-mail OTP plugin is behind strict wrapper routes. Password
  sign-in and implicit Google linking remain disabled. Existing Google owners
  enable e-mail from a fresh owner session and a separate verification code.

See [ACCOUNTS.md](ACCOUNTS.md) for current usage and [CLOUD_AUTH.md](CLOUD_AUTH.md)
for deployed secrets, migration and the human delivery acceptance check.

## Home welcome and settings design

The home application welcome screen should provide these independently
focusable choices, using the existing English UI language:

```text
Welcome to StreamerAI.
Choose how to keep your profiles and watch progress.

[ Continue locally ]
  No account required. Your data stays on this home server.

[ Sign in to StreamerAI ]
  Use your account across home installations. Sync is optional.

[ Use my Google Drive ]
  Sync with your own Drive. No StreamerAI account required.
```

The StreamerAI branch offers **Continue with Google** and, once mail is ready,
**Continue with e-mail**. Do not show working-looking buttons for unavailable
methods. The Drive branch explains what is stored, requests consent separately
and lets the user select their Google identity and existing dataset. Every
branch has a clear back/cancel action and preserves local data if setup fails.

After local entry, show the profile chooser/onboarding. Account settings offer
**Synchronization: Off / StreamerAI / Google Drive**, last success, pending
changes, errors and reconnect/disconnect actions. Distinguish **Switch profile**,
**Switch account**, **Sign out**, **Disable sync** and **Delete remote data**.
Disabling sync keeps local data and remote data; deletion is a separate explicit
operation. Changing a provider or Google identity requires a data preview and
confirmation before any upload or account ownership change.

On TV, local entry requires no phone. StreamerAI and Drive setup retain the
QR/code flow with explicit confirmation, request purpose and device name on the
phone. For Drive, the phone authorizes the home installation's Drive connector;
do not assume Google's limited-input device flow supports the required scope.

The public Worker `/login` remains an account portal and pairing entry point.
It cannot open a visitor's local database. Explain the local option there and
direct the user to their own home installation; never assume its URL is
`localhost` on the visitor's phone or redirect to arbitrary supplied addresses.

## Local access and ownership

Local entry creates a server-issued, revocable HttpOnly session scoped to an
explicitly local household account. It must retain account authorization,
profile locks, CSRF/origin checks and device session isolation. Do not implement
the button by globally disabling auth or letting anonymous requests choose an
arbitrary account ID.

This account represents household access from the trusted home network, without
an authenticated household administrator. It is not suitable for exposing the
home API publicly. A profile PIN keeps its existing limited household purpose.

The current pilot's legacy account may have ID `local` even after Google has
claimed it. Local entry must check ownership, never treat that ID as proof of
guest access, and must not expose its profiles or provider credentials. If the
legacy account has already been claimed, create/use a distinct local-only
household account. Entering local mode must not silently copy linked profiles.

For an unclaimed legacy installation, preserve its existing profiles, PINs and
shared connections on local entry. Signing in later must offer an explicit
review of adopting those profiles or opening a separate account. Preserve the
first-created profile's provider migration rule and verified pre-migration
backups. Existing linked accounts and active sessions retain their ownership.

Local/Drive accounts have no Google-owner PIN reset merely because they use
Drive. Initially retain the current PIN/backup recovery behavior; any new
administrator recovery mechanism needs its own design. For StreamerAI accounts,
e-mail recovery can later use fresh verification of the same registered owner.

## Separate local account, identity and sync binding

Prepare an additive migration and public API design around these concepts:

| Concept | Proposed contents |
| --- | --- |
| Local account | Stable local ID, household/verified-owner access policy, profiles and shared connections |
| Identity link | Optional StreamerAI cloud user ID; Google/e-mail are ways to verify that owner |
| Sync binding | Provider `none`, `streamerai` or `google-drive`; dataset ID, generation, status and secret reference |
| Sync ledger | Account + provider + remote owner/dataset namespace; operation IDs, durable pending changes and checkpoints |
| Installation | Stable random writer ID; device sessions remain scoped to that installation/account |

One active remote provider per account is the proposed first release. Keep
credentials encrypted in the existing server vault and expose only sanitized
capabilities/status to the browser. A dataset or Google identity change creates
a new binding namespace; never reuse another provider/account's cursor, ledger
or pending upload authorization. Local dirty capture must still support a later
explicit initial export when sync was previously off.

Capabilities should distinguish local entry, configured login methods, available
sync providers, transfer and recovery support. Replace the assumption that one
`enabled` flag describes all of these. Preserve compatibility while updating
server and web together; do not expose profile/account details before access is
established.

## Google Drive transport proposal

Use Drive API v3 `appDataFolder` with the narrow
`https://www.googleapis.com/auth/drive.appdata` scope. Google classifies this
scope as non-sensitive. App data is hidden from the Drive file UI and cannot be
shared between Google users. It can be deleted by the user, including when
removing the app. See [Google's app-data guide](https://developers.google.com/workspace/drive/api/guides/appdata)
and [scope classification](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Use the same safe user-state allowlist as D1: profiles/preferences, Library,
History, progress and small referenced-title descriptors. Provider credentials,
PIN verifiers, raw prompts, local paths, media links and files stay local.
Drive storage does not itself provide end-to-end encryption. Any such feature
needs a separate key distribution and recovery design.

Proposed file layout uses versioned immutable operation segments identified by
dataset, writer and unique segment ID, plus rebuildable checkpoint snapshots.
Do not overwrite one shared JSON/SQLite file from multiple installations:
concurrent writes would lose changes. Treat Drive file IDs as identities;
filenames alone do not establish uniqueness or idempotency. Retried uploads,
duplicate files, partial publication, pagination and out-of-order discovery must
be handled explicitly. Discover immutable segments directly; a shared manifest
must not become the sole authoritative list of concurrent writes.
Google's [file resource reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
documents file IDs and the absence of filename uniqueness within a folder.

Reuse operation-ID deduplication, deterministic conflict ordering, playback
session ordering and permanent deletion tombstones. Initially keep committed
Drive operations/tombstones and add bounded batch sizes, quota/error reporting
and backoff. The approved D1 90-day retention does not automatically apply to
Drive files; compaction needs a separate protocol proving offline recovery and
safe concurrent checkpoint publication before any pruning is introduced.

The five-profile limit also needs a transport-specific rule: two writers can
each add a fifth profile while offline. Before release, define deterministic
admission and keep any non-admitted local profile visible for explicit
resolution rather than deleting it or silently exceeding the remote cap.

Authorize offline Drive access independently of Google sign-in. The existing
Google identity flow requests `accessType: online`; it cannot simply supply the
Drive refresh credential. Enable Drive API in `streamerai-dev` only during
implementation, add the separate scopes/consent/callback and test reconnect.
With an external OAuth app in Testing, Drive refresh tokens normally expire
after seven days; the identity-only exception does not cover Drive. Public
rollout therefore needs the appropriate publishing/branding readiness, even
though `drive.appdata` is non-sensitive. See Google's
[offline access](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
documentation.

For LAN/TV compatibility, investigate a separate short-lived OAuth broker on the
existing Worker. It must work without creating a Better Auth user or D1 sync
account, bind state/PKCE and one-time credential handoff to the requesting home
installation, and require explicit owner consent. User-state files travel
directly between the home server and Google Drive. The home vault retains
refresh credentials; a confidential Web OAuth client needs a secure refresh
exchange because its client secret cannot be distributed with the application.
If the Worker brokers refresh, it transiently processes the refresh credential;
document that trust boundary and prevent an unauthenticated general refresh
proxy. Prototype and settle this flow before implementing the adapter. A fully
self-hosted OAuth configuration can be a later advanced option.

Drive app data cannot implement the existing two-owner cloud transfer by sharing
a file. Keep the current StreamerAI transfer as a cloud capability. A later
Drive/local profile move needs an explicit export/import and source ownership
workflow, preserving profile data while leaving credentials and PINs behind.
Do not present it as a completed cross-account transfer after copying a file.

## StreamerAI e-mail login with Brevo

Brevo is the proposed mail delivery provider. Authentication, code validation
and account ownership remain in the existing Worker/Better Auth/D1 service.
Use Brevo's HTTPS transactional API from the Worker; no browser mail client or
separate hosted authentication subscription is needed.

Checked on 2026-11-01: Brevo Free includes 300 sends/day, shared across the Brevo
account. Unused daily allowance does not carry over; transactional sends can be
queued after the quota is reached. Login codes must have their own expiry and
must not depend on a queued e-mail arriving in time. See
[Free plan limits](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan).

Before implementation/release, prepare:

- An owner-controlled Brevo account with transactional sending available and a
  verified sender. The owner has created the account and reports adding the
  sender/subdomain above; confirm Brevo's status indicators and actual delivery
  before relying on OTP delivery.
- The selected sender is `no-reply@7265001.xyz`, with branded subdomain
  `mail.7265001.xyz`. Confirm the domain is authenticated and the sender is
  verified in Brevo. Keep the application URL and mail domain as separate
  settings.
- The implementation uses the supplied static key as `BREVO_API_KEY` in Worker
  secrets. Its send-resource access is confirmed while account administration
  is denied; do not broaden those permissions to run unrelated account reads.
  Never place it in frontend bundles, source control or home browser settings.
- A private Brevo M2M app with `transactional.email:write` is a future optional
  credential change, not a prerequisite for the working static-key transport.
- Plain-text/HTML login-code templates, clear expiration, no marketing opt-in
  requirement, and delivery-failure/quota behavior.
- Better Auth e-mail OTP integration with one-time use, hashed/keyed code
  storage, bounded verification attempts, resend cooldown, e-mail/IP/global
  budgets and neutral responses that do not enumerate registered accounts.
- An explicit identity-linking flow. Adding e-mail login to the already linked
  Google owner must preserve the same cloud user and profiles. Do not merge
  users or transfer ownership just because e-mail strings match. Require
  authentication to the existing account and verification of the new method;
  keep separate accounts distinct when that proof is unavailable.
- A provider boundary so a different mail transport can replace Brevo later.

Proposed code policy: 8 numeric digits, 10-minute expiry, five verification
attempts and at least 60 seconds between sends. Finalize against Better Auth's
supported behavior during implementation. Never log codes or include them in
analytics. Brevo receives the recipient and the code to deliver; it does not
receive Library, History or media-provider credentials.

Keep Brevo's **Authorized IPs** restriction disabled for the current
Cloudflare Workers Free design. The Brevo API call originates from the hosted
Worker, not the owner's browser or home server, and this deployment has no
dedicated fixed egress IP to register. Do not add the owner's current IP or a
broad shared Cloudflare IP range as a substitute. Cloudflare documents
dedicated egress IPs as a Zero Trust Enterprise add-on; requiring a fixed
allowlist would need a different egress design and cost decision. Protect the
Brevo M2M client secret (or fallback API key) as a Worker secret instead. See
[Brevo IP blocking controls](https://help.brevo.com/hc/en-us/articles/5740111683858-Authorize-and-block-IP-addresses-for-API-and-SMTP-security),
[Brevo M2M setup and credential guidance](https://developers.brevo.com/docs/oauth-m2m-authentication),
[the transactional e-mail scope](https://developers.brevo.com/docs/oauth-scopes)
and [Cloudflare dedicated egress IPs](https://developers.cloudflare.com/cloudflare-one/traffic-controls/egress-policies/dedicated-egress-ips/)
and [how Worker fetch traffic uses dedicated CDN egress](https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/other-products/#workers).

See [transactional API](https://developers.brevo.com/docs/send-a-transactional-email),
[sender creation](https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email)
and [sender-domain requirements](https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders).

## Implementation order and release checks

1. Prepare additive account/access-policy and sync-binding migrations, scoped
   sessions, capabilities and provider boundaries. Rehearse on database copies
   and retain verified backups. No change to the currently linked owner's data.
2. Implement explicit local entry alongside cloud accounts, the home welcome
   choices, chooser/onboarding and account/sync settings. Verify local startup
   with the internet disconnected and no e-mail/Google interaction.
3. Prepare Brevo sender/secrets, add e-mail OTP and explicit Google/e-mail
   identity linking, and reuse device pairing for TV. Verify actual delivery,
   expiry, guessing/resend limits, quota errors and preservation of the real
   Google owner's profiles.
4. Prototype Drive OAuth, refresh and TV handoff without StreamerAI registration.
   Settle immutable publication, duplicate discovery, offline five-profile
   admission, checkpoints and disconnect semantics before enabling Drive UI.
5. Implement the Drive adapter and verify two independent home databases with
   concurrent offline changes, retries, progress restarts, deletions, restart
   recovery, quota errors, expired/revoked authorization and removed app data.
6. Verify mode/provider changes through a preview/import flow: preserve local
   edits and PINs, isolate credentials and namespaces, enforce profile limits,
   and never erase the previous remote dataset during ordinary disconnect.
   Remote data removal must not silently trigger re-upload; keep it paused until
   the user explicitly selects import, a new dataset or reconstruction.

Primary code areas for later work: `apps/server/src/services/account-auth.ts`,
`account-sync.ts`, `packages/database/src/accounts-repository.ts`, database
migrations/types, `packages/contracts/src/account-sync.ts`, web `App.tsx`,
`AccountLogin.tsx`, `AccountSettings.tsx`, `api/client.ts`, and cloud `auth.ts`,
hosted login/device pages, temporary grants and deployment documentation.

Remaining checks are actual Brevo delivery/owner acceptance, actual TV and
two-owner profile-transfer acceptance, plus the Drive OAuth/publication
prototype and adapter. Local entry and e-mail implementation do not wait for
Drive. Apple remains outside this extension's scope.
