# Household server and thin clients

The ownership hierarchy is cloud account → households → profiles. A household
is a home server and its local SQLite database, with an independent UUID. The
cloud account is optional. The server remains usable when the cloud is offline
or disconnected.

## Installation and creation

1. Install the server, persistent database and encrypted credential vault.
2. Open `/admin`. A server without a household opens **Set up your household**
   directly, with no installation key. Its temporary setup session can only
   create or restore the household; it cannot manage profiles, devices or services.
3. Create a household with an 8-digit Master PIN, import an encrypted household
   using its existing PIN, or sign in to cloud management. Cloud sign-in offers
   existing households (and their backups) or creation of a new household.
4. Configure profiles, shared services and backup frequency in administration.
5. Open `/` for viewing, or install a thin client and select the home server.

The PIN is not created again during restore. It protects portable backups and
authorizes local clients. Changing it requires the current PIN. A fresh cloud
owner sign-in can authorize a local reset for five minutes; the server performs
that reset. Earlier backup files still require the PIN used when they were
created. The cloud does not store the Master PIN or a remote PIN verifier, so
restoring from cloud also requires the existing household PIN. Successful PIN
creation or backup decryption authorizes the browser as household administrator.

## Client authorization

The desktop or Android/TV shell discovers server announcements on UDP 47777
(multicast `239.255.77.77` and local broadcast), then checks the advertised server
identity at `/api/v1/installation/discovery`. Discovery is a convenience and
does not authorize access. A remembered server's identity must match. Manual
address selection remains available when network isolation blocks discovery.

The client loads the server's viewing web application. A new client requests a
local pairing, displays a six-digit code and QR to `/admin/pair?code=…`, and waits
for the owner to approve it. The QR uses the server URL; it is not a cloud pairing.
Alternatively the user enters the Master PIN. “Sign in on this device” opens
the local server's administration sign-in. Cloud sign-in there is available
only when the household is already linked to that account.

The server issues a random client UUID and independent secret in an HttpOnly
cookie, bound to its server identity and household. Viewers cannot use owner
administration endpoints. Owners can revoke devices locally. The native shell
retains the selected server and a native installation UUID; the server-issued
cookie remains the authorization credential. Cloud attach/detach does not
invalidate local authorization. Portable household imports exclude pairings
and server identity, so a replacement server requires pairing again.

Chrome and an editor's embedded browser have separate cookie stores. Each must
pair or enter the household Master PIN independently; both can stay connected
at the same time. Expired installation authorization returns to that connection
screen. After upgrading from an older web client, use a hard refresh if the
browser still shows the previous cloud-only sign-in screen.

The native shell provides discovery, navigation, persisted server selection
and web playback. Platform WebView/Chromium codec support still determines
direct playback capability; the existing server transcoding path is unchanged.

## Cloud and backups

Cloud device tokens are scoped to one household after registration. Initial
login grants can list owned households and register/select one, but cannot
read or write another household's synchronization stream. Cloud data and backup
revisions use household UUID namespaces rather than the account UID.

The local encrypted vault holds the server cloud credential. Disconnecting
revokes it and clears the link, while retaining profiles, PIN and clients.
Deleting a remote copy is an independent action. PIN resets, local pending
pairings and connected clients are managed by `/admin`; linked sign-in methods,
ownership transfers and household requests are managed by the cloud portal.

Automatic local backups default to hourly, with an adjustable 15-minute to
seven-day interval. Each is an atomic, PIN-encrypted JSON file under the data
directory. They have no automatic retention deletion. Cloud backups have an
independent enable switch and use the configured interval. The UI reports
pending, saving, current or error with the last successful upload time. Uploads
use revision comparisons, and a changed remote copy is never overwritten
silently. Structured profile/viewing sync remains allowlisted plaintext on D1;
portable backups contain encrypted profile data and provider credentials.

An encrypted merge requires cloud approval and the source household PIN on the
target server. The server previews and imports source profiles, remaps their
identities and preserves the target PIN, UUID and existing shared services.
Missing service credentials may be copied. The five-profile limit is checked
before import. Only after uploading the resulting target backup does the cloud
mark the source merged and revoke its cloud server tokens. Source ciphertext
and local source data are preserved. Changes to the source after approval
reject finalization; durable local journals make retry safe after interruptions.

## Deployment notes

The frontend must route `/admin/**` to the SPA entry point; the repository's
Nginx and Caddy configurations do so. Expose the web proxy and UDP 47777, not the
Fastify API directly. Set `STREAMERAI_ADVERTISE_URL` to a client-reachable web
origin in Docker. Container port publishing and multicast behavior depend on
the host network; manual URL entry remains necessary on isolated networks.

Deploy D1 migration `0011_households.sql` before the matching Worker. It creates
household registry, synchronization and request tables without deleting archived
account PIN records. The old cloud-global PIN endpoints return HTTP 410.
No production migration or deployment is performed by switching to this branch.

Migration 0011 assigns a synthetic `Household` UUID to old cloud profiles when
there is no checkpoint carrying the original household UUID. Server registration
includes profile sync IDs so the Worker can recognize this exact migrated
namespace and move its records to the server's stable UUID in one transaction.
This repair requires the same owner and complete active profile set, no source
backup or live server, and an empty target synchronization namespace. The target
backup stays unchanged. Partial matches and established households require
explicit review rather than automatic reassignment. Linked household renaming
must succeed in the cloud before the local name is saved.
