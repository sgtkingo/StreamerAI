# Hellspy stream source

Hellspy is an optional `MediaProvider` with guided account setup. In Settings →
Stream sources, choose Hellspy and enter the account email and password. A valid
login and a non-anonymous identity check are required before the connection is
saved. The password is discarded; only the access token and its expiry are
stored in the profile's encrypted `SecretStore` (memory only in development).
There is no anonymous fallback, even though some upstream endpoints are public.

Stored source records survive disconnect, but catalog, detail, Library, History
and episode-search responses show only providers connected for the current
profile. Cached episode candidates from a disconnected provider cannot make an
episode ready. Search limits are shared fairly between providers across title
variants: an early Hellspy match does not prevent a Webshare lookup under the
localized or plain Latin spelling (for example `Shippūden` → `Shippuden`).

## Upstream protocol

The adapter uses the JSON API called by [Hellspy's web application](https://www.hellspy.to/),
rather than scraping HTML or relying on the former hellspy.cz API. Public
JavaScript and live search/detail responses were inspected on 25 October 2026.
These endpoints are not a published, versioned third-party API:

| Method | Fixed-origin path at `https://api.hellspy.to` | Purpose |
| --- | --- | --- |
| POST | `/login` | JSON `email`, `password`; returns `accessToken`, `expires` |
| GET | `/identify` | Bearer token; must contain a non-null token and user |
| POST | `/refresh_token` | Renew an unexpired token within five minutes of expiry |
| GET | `/gw/search?query=…&offset=0&limit=…` | Bounded video search |
| GET | `/gw/video/{id}/{fileHash}` | Video details and signed conversion URLs |

`/identify` returns HTTP 200 with null identity fields for anonymous requests;
HTTP success alone is not proof of authentication. Every search, inspection,
playback preparation and source renewal verifies the saved session. Concurrent
identity/refresh requests share one job; cancelling one caller does not cancel
the other caller's verification. Expired or rejected tokens require reconnecting.
No account is created automatically.

Candidate IDs encode the video ID and file hash. A variant additionally records
its conversion key. Original (`0`) is preferred when offered; otherwise the
highest supported resolution is selected. Renewal preserves that exact quality.
Movie searches include the year; episode searches use the episode term without
the series premiere year. Search matches remain derived candidates and pass
through the existing title/year/episode validation pipeline.

Stream URLs are limited to credential-free HTTPS on `hellspy.to`, `onecdn1.net`
and their subdomains, with standard ports. Redirects are rejected. Bearer tokens
are sent only to the fixed API origin and never to the CDN. Playback checks use
a one-byte range request. Conversion resolution comes from the API, codecs and
languages from FFprobe; filenames do not prove codec or language. Search size
describes the original file and is not reused as a conversion's byte size.

## Lifecycle and resilience

The server exposes:

- `POST /api/v1/integrations/hellspy/connect`: `{ username: email, password, profileId? }`.
- `POST /api/v1/integrations/hellspy/check`: `{ profileId? }` to recheck/refresh the saved session.
- `DELETE /api/v1/integrations/hellspy?profileId=…`: delete that profile's session and connection.

A failed connection attempt preserves the previous saved session. Failure to
persist sanitized connection state rolls the vault back. A rejected recheck
marks the source as requiring action. Deleting a profile deletes its token.
Public responses, discovery records and logs contain neither tokens nor signed
stream URLs. Playback grants expire after one minute and use the existing
same-origin player and ephemeral ticket store.

Transport requests time out after eight seconds, JSON bodies are limited to
2 MiB, search requests fetch at most 64 results, and the shared connector budget
allows at most 120 upstream requests per minute. There are no automatic retries;
HTTP 429 or three consecutive retryable transport failures open a 30-second
backoff window. Search results, identities and signed URLs have no adapter cache;
the coordinator's normalized availability cache remains independent. There is no
crawl or catalog mirroring. Connection, health and transport errors use sanitized
provider error codes and distinguish provider failure from a valid empty search.

The [service terms](https://www.hellspy.to/terms-and-conditions) were reviewed for
the adapter's account-scoped, bounded access. They prohibit overloading the
service, bypassing its security, disrupting it with automated requests, sharing
accounts, and infringing content. This adapter uses the user's own account and
the normal web API without bypasses. No special third-party API permission or
availability guarantee was established.

## Validation

Offline fixtures cover login verification, rejected and expired sessions,
refresh concurrency, profile isolation, secret redaction, storage rollback,
disconnect, normalized search/variants, episode queries, CDN allowlists,
timeouts, cancellation, response limits, rate limiting and playback tickets.
The Settings connection form also has a UI test.

Live checks confirmed public search/detail shapes and HTTP 206 byte ranges for
Big Buck Bunny. A real-account login/refresh and complete player/seek smoke test
remain to be run with the user's credentials entered through Settings. Upstream
schema changes must fail closed and be handled inside this adapter.
