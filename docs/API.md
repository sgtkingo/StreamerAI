# HTTP API

The current API prefix is `/api/v1`. During local development Vite proxies this
prefix to the Fastify server. JSON requests with a body must send
`Content-Type: application/json`; requests without a body should not send an
empty JSON content type.

## Health and setup

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health/live` | Process liveness. |
| `GET` | `/health/ready` | Secret and integration-state store readiness. |
| `GET` | `/setup/status` | Required onboarding steps and storage durability. |
| `POST` | `/setup/complete` | Save the default profile and preferences. |
| `GET` | `/integrations` | Sanitized public integration catalog/status. |
| `POST` | `/inference/detect` | Bounded local Ollama detection. |

`POST /setup/complete` accepts:

```json
{
  "profile": {
    "name": "Viewer",
    "locale": "cs",
    "preferences": ["mystery", "comedy"]
  },
  "localAiEnabled": true
}
```

## Home and discovery

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/home?profileId=default` | Populated Home sections for one profile. |
| `POST` | `/discovery/fast` | Bounded metadata/media lookup without an agent; returns provisional validated titles for a shared session. |
| `POST` | `/discovery/sessions` | Run or continue conversational discovery. |
| `POST` | `/discovery/cancel` | Cancel the deep discovery request by `profileId` and `idempotencyKey`; a parallel fast request continues. |

Discovery request:

```json
{
  "profileId": "default",
  "message": "I want an autumn movie with Sandra Bullock",
  "idempotencyKey": "client-generated-stable-key",
  "sessionId": "shared-session-for-parallel-initial-search",
  "createSession": true
}
```

The initial fast request uses the same `sessionId` and `idempotencyKey` but
omits `createSession`. Chat follow-ups use the existing session and omit
`createSession`.

A completed response contains `mode`, `bestMatch`, `available`, `unavailable`
and `unverified` groups. `unknown` availability belongs only in `unverified`;
it is never silently reported as factual unavailability. Live responses also
require metadata, rating and availability provenance. The best match is always
playable. The default coordinator returns `mode: "preview"`, an explicit
warning, and no Play action.

Sessions and messages are durable SQLite records. `idempotencyKey` is scoped to
the profile for the deep request: replaying the same body returns its stored
response, while reusing the key for different input returns
`IDEMPOTENCY_CONFLICT`. A supplied unknown or closed `sessionId` returns
`DISCOVERY_SESSION_NOT_FOUND` unless an initial parallel request explicitly
sets `createSession: true`.

Live Home searches start `POST /discovery/fast` and `POST /discovery/sessions`
in parallel with the same client-generated `sessionId`, message and request
key. The fast route uses only metadata/media adapters, persists newly validated
titles, and does not invoke Ollama. Its bounded candidate shortlist passes
through the same source-matching and format validation as Deep. Media lookup
tries original and localized title variants, with and without release year,
and inspects up to 12 file candidates per query until it finds three verified
sources. If the provider search limit is reached or file inspection is
truncated without a usable source, availability is `unknown`; only exhausted
bounded queries without a match are `unavailable`. The deep request sets
`createSession: true`; either route may create the shared session first, while
the initial user message is stored only once. The client merges results by
canonical ID, retaining verified streams and alternate sources from either
lane. An unambiguous exact-title Fast hit takes priority over an unrelated
model suggestion, while contextual Deep rankings can improve broader queries.
The merged response contains each title once. Later successful `playback/check`
calls promote tiles into the playable group for the current view rather than
leaving them in "Found, not currently available". This does not rewrite the
stored discovery response or canonical title. A pending check remains unknown.
Stop cancels only the deep request; fast results already shown (or still in
flight) remain usable.
The floating result chat sends the current session's ID with each follow-up,
so objections refine that shortlist without mixing unrelated searches. A
still-pending initial Fast request is discarded when the user starts a chat
refinement, so its late response cannot replace newer conversation results. A fast
reply is retained in the conversation for follow-up context; validated Fast
matches can also inform Deep when timing permits, but correct merging never
depends on that race. Each successful deep reply
ends with a question inviting feedback. A cancellation that arrives before
the deep request is registered is remembered briefly, so it cannot start
afterward.

## Library, History and playback

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/profiles` | List up to five viewer profiles with non-secret playback and taste preferences, including `onboardingComplete`. |
| `POST` | `/profiles` | Create an incomplete viewer profile from `{ "name": "Alex", "locale": "cs" }`; returns `409 PROFILE_LIMIT_REACHED` after five. |
| `PATCH` | `/profiles/:profileId` | Update display name, interface locale, genre list, taste prompt or playback preferences. |
| `GET` | `/profiles/:profileId/library` | List the profile Library. |
| `GET` | `/profiles/:profileId/titles/:titleId` | Open a validated film/series detail. A series response includes a progressively updated season/episode guide; poll while `series.status` is `searching`. Related titles come only from the validated local catalogue. |
| `PUT` | `/profiles/:profileId/library/:titleId` | Explicitly save a validated title. |
| `DELETE` | `/profiles/:profileId/library/:titleId` | Remove Library membership. |
| `GET` | `/profiles/:profileId/history` | List newest playback events. |
| `DELETE` | `/profiles/:profileId/history/:eventId` | Remove one history event. |
| `POST` | `/profiles/:profileId/history/clear` | Clear history after an explicit confirmation token. |
| `POST` | `/profiles/:profileId/playback/check` | Verify a tile or selected episode asynchronously without issuing a grant or recording History; return detected audio and playable subtitle languages when media probing succeeds. Optional `sourceId` checks exactly one known file. |
| `POST` | `/profiles/:profileId/playback/prepare` | Recheck the source and issue a short lived grant without changing Library or History. For a series episode, send `{ "titleId": "...", "seasonNumber": 1, "episodeNumber": 2 }`; both episode fields are required together. Optional `sourceId` selects exactly one file belonging to that title and episode. |
| `POST` | `/profiles/:profileId/playback/start` | Legacy one-call prepare and start for clients that do not use the two-stage flow. |
| `GET` | `/playback/grants/:grantId/manifest` | Probe duration, seekability, source size/identity, media tracks, and discovered external subtitles. |
| `GET` | `/playback/grants/:grantId/media?audio=2&start=31.500` | Stream browser-compatible fragmented MP4 with selected audio and a start offset. First request records playback once. `refresh=1` obtains a fresh private provider link for an explicit retry. |
| `POST` | `/playback/grants/:grantId/progress` | Save the progress percentage, position and duration for the selected film or episode. Requires a started ticket, except a zero-percent reset before playback. |
| `GET` | `/playback/grants/:grantId/thumbnail?at=30` | Generate a small JPEG preview near the requested second. |
| `GET` | `/playback/grants/:grantId/subtitles/:streamIndex/window?startMs=120000&durationMs=120000` | Return an aligned JSON window with absolute millisecond cues for one embedded text track. |
| `GET` | `/playback/grants/:grantId/subtitles/external/:fileId/window?startMs=120000` | Return a JSON window from a discovered and authorized external subtitle file. |
| `DELETE` | `/playback/grants/:grantId` | Stop/revoke the active ticket. |

Playback body:

```json
{
  "titleId": "sai:canonical:title-id"
}
```

Playback is disabled in preview mode. Live tiles call `check` automatically;
Play becomes available only after that check succeeds. `prepare` reinspects
the selected file, obtains a Webshare VIP link and requires a successful
one-byte HTTP Range response (`206`) with a valid `Content-Range`. The browser opens the in-app player and
requests the manifest, then the media endpoint. The server uses FFmpeg to
remux or transcode the chosen source; the direct Webshare URL remains only in
the in-memory ticket store and never reaches the browser. A first media
request records History and extends the active session for a film-length
window. Seeking or switching audio restarts the media response at the chosen
position. The server refreshes the private provider link for later media
requests, so an expired direct link does not break a seek. Local subtitle files
are converted to WebVTT in browser memory.
Only text-based embedded subtitles can be extracted; bitmap tracks are omitted.
The player fetches canonical two-minute subtitle windows and renders normalized cues against the absolute playback position,
including resume/seek offsets. Profile playback preferences include an output
device ID and subtitle size, color and font. Multichannel source audio is
downmixed to stereo in the browser stream for compatibility; selecting a
different output device depends on `setSinkId` support and permission.

`check` reports current playback readiness and optional track languages, not
a replacement catalog title. The client may use a successful check to
reclassify a tile in the visible search result; durable availability and source
metadata are still updated through validated discovery/upsert. `prepare`
performs a fresh source check even when the earlier tile check succeeded.

Live title objects may include `sources`: inspected provider files with stable
32-character IDs, provider candidate references, quality/language hints and
episode coordinates. Direct playback URLs are never included. Without
`sourceId`, playback can fall back through the ranked candidates; an explicit
`sourceId` never falls back. The current player handles one selected file per
grant and does not merge tracks from multiple files.

A successful `check` returns `{ "ok": true, "audioLanguages": ["ces", "eng"],
"subtitleLanguages": ["cs"] }` when track inspection succeeds. The language
arrays describe the checked source or episode, not every release of a series.
If track inspection times out, the availability check can still succeed with
`{ "ok": true }`; the tile may then use catalogue format hints. Tiles order
audio by the viewer's primary and secondary playback preferences, show `(sub)`
for an alternative language with embedded text subtitles, and show `(!)` when
the checked audio is outside those preferences and has no playable subtitles.
Issuing a new grant revokes the previous one. Errors use stable codes such as
`PLAYBACK_GRANT_EXPIRED` and `PLAYBACK_MEDIA_UNAVAILABLE`.

Playback diagnostics are structured server logs (`docker compose logs -f --tail=200 server`):
manifest readiness/failure, stream start/finish/failure,
thumbnail and subtitle failures. They include only fixed event/failure codes,
processing phase, counts and numeric FFmpeg exit/byte values. Raw FFmpeg
stderr, provider URLs, exception messages and playback grant IDs are never
logged. The server masks grant IDs in request paths, and Nginx disables route
access/error logging for playback-grant routes. A browser-side media error remains visible
in the player but is not persisted as a client log.

History clear accepts `{ "confirmationToken": "clear-history" }`. Clearing
History never removes Library membership.

## TMDB connection

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/integrations/tmdb/check` | Verify a read token without saving it. |
| `POST` | `/integrations/tmdb/connect` | Verify, then save through `SecretStore`. |
| `DELETE` | `/integrations/tmdb` | Delete the token and disable the connection. |

Both accept `{ "token": "..." }`. Public responses are an allow-listed shape:

```json
{
  "integrationId": "tmdb",
  "ok": true,
  "status": "connected",
  "messageCode": "CONNECTED",
  "persistence": "memory"
}
```

No response contains the token, an internal secret reference, upstream body or
sensitive header. Expected failure codes include `CREDENTIAL_REQUIRED`,
`CREDENTIAL_REJECTED`, `RATE_LIMITED`, `TIMEOUT`, `INVALID_RESPONSE`,
`PROVIDER_UNAVAILABLE` and `SECURE_STORAGE_UNAVAILABLE`.

## Webshare connection

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/integrations/webshare/connect` | Exchange local username/password for WST, then store only WST through `SecretStore`. |
| `DELETE` | `/integrations/webshare` | Delete WST and disable the connection. |

Connect accepts `{ "username": "...", "password": "..." }`. The password is
used only during the request to calculate Webshare's documented legacy
`SHA1(MD5_CRYPT(password))` value; it is not persisted. Responses use the same
allow-listed connection result as TMDB and never contain the password, digest,
salt, WST or account identifier.

## Integration preparation boundaries

- `POST /inference/detect` runs the bounded Ollama version, installed-model,
  metadata, structured-output, tool-call and residency checks. It does not
  expose an arbitrary inference proxy.
- Production composes Ollama, TMDB and Webshare into the live discovery
  coordinator. The model proposes bounded candidates; TMDB verifies canonical
  facts and explicitly named people, then Webshare verifies playable files and
  formats before a title reaches the response.
- The Webshare transport, guided `salt`/`login` exchange, normalized
  `MediaProvider` adapter and FFmpeg media gateway are implemented. A real-account
  browser playback and seek trial remains a release gate; no endpoint accepts a
  caller-supplied WST or returns it to the browser.

## Versioning rules

Shared request and response shapes live in `packages/contracts`. Additive
changes should remain backward compatible inside `/api/v1`. Breaking changes
require a new versioned route and a migration window for the web client.
