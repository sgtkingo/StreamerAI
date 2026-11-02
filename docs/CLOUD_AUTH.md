# Cloudflare identity deployment

The `apps/cloud` Worker owns Google/e-mail sign-in, device grants, owner-approved
profile transfers and user-state synchronization. Cloudflare resources remain
in the owner's account. No media or local provider credentials go to D1.

Configured pilot resources:

| Resource | Value |
| --- | --- |
| Worker | `streamer-ai` |
| Origin | `https://streamer-ai.streamer-ai.workers.dev` |
| D1 | `streamer_ai_free` |
| D1 ID | `17d0928c-029c-4941-a9c9-7c7e4429f277` |
| D1 jurisdiction | EU |
| Google project | `streamerai-dev` |
| Google callback | `https://streamer-ai.streamer-ai.workers.dev/api/auth/callback/google` |

## Configuration

`apps/cloud/wrangler.jsonc` contains public identifiers and the D1 binding.
These values must be Worker **secrets**, never committed variables:

- `BETTER_AUTH_SECRET`: cryptographically random, at least 32 bytes; preserve
  it between deployments because it protects sessions and stored OAuth tokens.
- `GOOGLE_CLIENT_ID`: the project's Web OAuth client ID.
- `GOOGLE_CLIENT_SECRET`: the matching Web OAuth client secret.
- `BREVO_API_KEY`: the supplied mail key; never expose it to a home browser.

`MAIL_FROM=no-reply@7265001.xyz` is public Worker configuration. The sending
domain and branded `mail.7265001.xyz` subdomain are configured in Brevo; the
identity application continues to use its existing workers.dev address.
Authenticated domain ownership does not require moving the application URL.

The ignored `.secrets/google-oauth-dev.json` can hold Google's downloaded Web
client configuration locally. Do not copy it into `apps/cloud/src`, a web
bundle, a container image or logs. `.dev.vars` is ignored and reserved for a
separate local development client/database.

Enable Google Authentication Platform in the existing project, configure
branding/audience and register the exact origin and callback above. Keep the
pilot in Testing with the intended Google test users. OAuth app verification
and the public-production audience are separate rollout steps.

## Deploy

From the repository root, with pnpm 10 and the owner's Wrangler login:

```sh
pnpm --filter @streamer-ai/cloud typecheck
pnpm --filter @streamer-ai/cloud test
pnpm --filter @streamer-ai/cloud build
pnpm --filter @streamer-ai/cloud db:migrate:remote
pnpm --filter @streamer-ai/cloud deploy
```

For the first deployment, add the secrets from a trusted terminal in
`apps/cloud`, using the interactive prompts (or a protected JSON stream with
`wrangler secret bulk`):

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put BREVO_API_KEY
```

Future code deployments retain those secrets. Do not regenerate the auth
secret on every deploy. Apply additive D1 migrations before deploying code
that depends on them. For upgrades with existing data, record a D1 Time
Travel bookmark/export and keep a rollback-compatible Worker version.

Verify `/health`, `/login`, `/assets/auth.js` and `/assets/auth.css`. An
anonymous `/v1/account` must return 401. Test Google sign-in from the hosted
page, then use the device flow from the home application. A successful
OAuth initiation alone does not prove the human consent/callback works.

## Free tier and operations

This configuration uses Workers and D1 only. It does not enable Workers Paid,
R2 or a paid authentication service. E-mail codes use Brevo's free allowance;
Apple and Google Drive remain deferred. Monitor both providers' limits.

Brevo API IP blocking must stay disabled for this Workers Free deployment,
which has no dedicated fixed egress address. Keep the key in Worker secrets.
The supplied key rejects account/sender administration reads with 403; those
permissions are unnecessary. An invalid, recipient-free send request reached
input validation (400), confirming access to the send resource without sending
an e-mail. M2M is a possible later credential change, not a prerequisite for
using the supplied key.

OTP policy is eight digits/ten minutes/five attempts, keyed hashing, one send
per recipient per sixty seconds and quotas of six requests per recipient/hour,
ten per source IP/hour and 250 globally/day. These conservative request budgets
reserve room under Brevo Free's 300 daily sends; other uses of that Brevo account
also consume its allowance. Provider acceptance alone is not proof of delivery.

Migration `0004_email_login.sql` adds explicit e-mail-method enrollment and
persistent cooldowns without rewriting existing users or sessions. Scheduled
maintenance also removes old expired verification/cooldown rows. E-mail setup
and Google linking require a fresh browser session; device tokens cannot add
login methods. OTP plugin endpoints for passwords, raw-code retrieval and
address changes remain closed.

The e-mail extension was deployed on 2026-11-01 as version
`7a6a8e5b-99d3-4ca9-b79a-63b15f688e96` after a D1 recovery bookmark and the
additive migration. Health/login/scripts respond successfully; anonymous account
reads remain 401. The real Google user/session and both user-state entities
remained present. The Worker is approximately 435 KiB gzip with 74 ms startup.
At that release, the owner's actual mail delivery/OTP acceptance was pending;
the confirmed outcome is recorded below.

The owner then reported missing codes and a hanging Google sign-in. Live probes
reproduced stalled auth requests while static pages and device sync remained
healthy. Auth instances are now scoped to each Worker request so pending D1/auth
initialization from a disconnected request cannot be reused by later requests.
Auth calls have a 15-second limit and hosted fetches a 20-second limit. Mail
rejections log only the HTTP status, without recipient, code or provider body.
This repair and the sanitized `/v1/account/connections` endpoint were deployed
as `a75a8ef2-50d8-43f2-8263-5440e3e70408` on 2026-11-01. Browser auth now
initializes lazily, so bearer-only device/sync requests avoid its schema queries.
Repeated live OAuth
initiation and anonymous owner-only enrollment probes responded promptly;
the normal rapid sign-in limit still returns 429. Human Google callback and
mail delivery needed reconfirmation at that point. No diagnostic mail was sent.
Brevo's aggregate delivery report returned zero requests/deliveries for that
day when checked after the first failed owner trial. The earlier attempts appear
to have stopped before submission to Brevo; this is not proof that delivery
after the repair succeeds.

After Google sign-in recovered, a second owner trial still received no code.
Anonymized live tracing then showed 429 on both enrollment and public-code
requests. Repeated clicks during the 60-second cooldown had been consuming the
hourly budgets, and their error appeared below the portal sections instead of
beside the button. Version `c11ac110-8e73-4fb7-b185-883b7cc71412` checks an
existing cooldown before spending budgets, returns `Retry-After`, and shows
mail progress/errors beside the enrollment button. One pilot recipient counter
and the confirmed matching installation IP counter were reset after saving
their old values; other limits, sessions, codes and user data were untouched.
Brevo API validation in its official sandbox returned 201 without sending any
message. This does not validate sender activation or delivery. Provider errors
now record only allowlisted error codes and coarse reason categories in logs.
The repeat owner send then exposed the original transport failure below.

The next owner trial returned 503 in 329 ms without a Brevo rejection event.
The original failure was reproduced with the deployed bundle in local workerd:
the mail transport used `redirect: "error"`, which Workers rejects with a
TypeError before making a network request. Node's fetch accepts that option,
so the earlier mocked Node tests missed the runtime incompatibility. The fix
uses `redirect: "manual"` and rejects non-2xx responses, preserving the policy
that a redirect must never forward the Brevo API key to another host. See
[Cloudflare's Request redirect modes](https://developers.cloudflare.com/workers/runtime-apis/request/#constructor).

Version `bde1e45e-bc14-4c4a-9816-d45eb5d42c1e` deploys this fix. Two workerd
regression tests verify an outbound submission and rejection of a cross-host
redirect. They use only a fake transport. An additional isolated full-bundle
check with actual local D1 completed e-mail signup, session creation and explicit
Google-owner e-mail enrollment on the same user, with no actual mail sent.
The pinned local workerd supports compatibility dates through 2026-10-30;
production remains configured for 2026-11-01. After deployment, the owner
confirmed actual Brevo code delivery and successful activation on 2026-11-01.
The anonymized live trace confirms `POST /v1/account/email-login/confirm` and
the refreshed method state both returned 200. A subsequent public sign-in-code
request also returned 200. A later live trace confirmed the final signed-out
OTP sign-in returned 200 and the account portal loaded successfully.
Temporary live diagnostic tracing was stopped after acceptance.

The subsequent report of missing sign-in codes was traced to mailbox placement:
Brevo recorded three accepted deliveries to the pilot owner's address at 21:54,
21:55 and 21:56 Prague time, and the owner found the messages in Spam or another
folder. Public DNS exposes both Brevo DKIM public keys, the Brevo verification
record and DMARC. These records do not guarantee inbox placement; the recipient
must mark an incorrectly filtered message as not spam or move it into the inbox.

Version `dd98da6b-c4bf-45da-a6b4-b45cf7f7b2ee` distinguishes activation and
sign-in messages, gives each request a dated subject to avoid old conversation
grouping, and keeps the OTP out of the subject. The hosted login now shows
feedback next to its form, identifies the requested address, reminds the owner
to check other folders and use the newest sign-in code, and counts down to a
resend. Failed sends never reveal an unsent-code form; 429 respects the server's
retry interval. Tests cover these states and preserve neutral public responses
for Google owners who have not enabled e-mail sign-in. No additional real mail
was sent by diagnostics or deployment. Subject changes are an aid to finding
codes, not a claimed fix for spam classification.

Local Settings reads provider enrollment with its existing device credential.
Linking still requires a fresh hosted browser owner session. The portal checks
the owner ID supplied by Settings before enabling account actions. Apple is
listed as unavailable; enabling it will also require provider registration.

As checked on 2026-11-01, Workers Free allows 100,000 requests/day and D1 Free
allows 5 million rows read/day, 100,000 rows written/day, 5 GB/account and
500 MB/database. A sync operation can write several indexed rows; an API
request is not equivalent to one D1 write. Polling and multiple installations
consume the same account quota. Free is appropriate for this pilot, not an
unlimited hosting commitment.

The owner approved automatic retention on 2026-11-01. The six-hour scheduled
task deletes only sync log entries and operation receipts whose server-side
creation time is strictly older than 90 days. Current profile, Library,
History and playback state, ownership and deletion tombstones are retained.
Monitor database growth: the retained current state still consumes storage.

Migration `0003_sync_retention.sql` adds receipt timestamps, age indexes and a
per-account retained cursor floor. Existing receipts without a reliable age
start their 90-day window at migration time. A compatibility trigger also
timestamps receipts written by the previous Worker during rollout.

Compaction records the last removed sequence and deletes expired rows in one
D1 transaction. Delta/snapshot page reads also read the cursor floor atomically
with their data. A cursor behind that floor receives
`410 {"error":"cursor_expired"}`. Updated home clients preserve their ledger
and pending offline writes, request a fresh snapshot and continue syncing.
Recovery is bounded to two snapshot resets per synchronization run; repeated
failures keep local data for a subsequent retry. Apply the migration before
deploying the Worker, and update home clients before the first 90-day purge.

The retention release was deployed on 2026-11-01 as Worker version
`6dcc07f0-a5ab-401b-aaf6-78d36160f434`, after recording a D1 recovery bookmark
and applying migration `0003_sync_retention.sql`. Post-deployment checks
confirmed the existing Google account/session and synchronized state remained
present, all receipts had timestamps, and no sync logs were yet old enough
to delete. The linked home installation continued synchronizing successfully.

See the current official [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) before
increasing usage. D1 Free currently retains Time Travel recovery for seven
days. Keep independent local database/vault/key backups.

The six-hour scheduled task expires stale rate-limit buckets, device grants
and old temporary transfer/device records. Ownership and deletion tombstones
remain durable. Profile transfers require a Google browser owner session;
device credentials cannot initiate or accept them. PIN recovery credentials
are short-lived and cannot synchronize data. Hosted pages reject foreign
origins, use external same-origin scripts/styles, disable framing and never
render API text as HTML.

## Ownership and recovery

The hosted account page can remove a linked Google login or disable e-mail
login. Both actions require a freshly authenticated browser session and keep at
least one available sign-in method. Removing a device from the account page
revokes its access and removes its entry; the home device can still revoke its
own credential when signing out.

Device pairing requests start without an account association. The account page
therefore shows only pending requests whose QR code or manual code the owner has
already opened while signed in. The owner can return to the account page before
confirming, review or reject the request there, and return to the pairing page
to confirm its code. Requests that have not yet been associated with an account
cannot be safely listed by account.

The owner manages the Cloudflare account, billing, access and recovery. Keep
Cloudflare and Google recovery methods current and enable MFA. Store the
auth secret and Google configuration with the installation's protected
operational backups. Losing a local vault master key requires reconnecting
providers; cloud sync cannot reconstruct their credentials.

For this pilot, the auth key backup is in the Git-ignored
`.secrets/streamerai_cloud_auth_secret`; the Google download remains in
`.secrets/google-oauth-dev.json`. Keep both private and back them up securely.

The Worker can read synchronized data; this is TLS plus provider encryption
at rest, not end-to-end encryption. Moving to a custom domain requires
updating `AUTH_ORIGIN`, Google's allowed origin/callback and the home
account-service URL together, then signing in again.
