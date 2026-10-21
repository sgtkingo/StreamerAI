# Second-sight validation

This document records the independent review passes performed before the
current handoff. It describes code evidence, not a claim that external provider
acceptance tests have already happened.

## First pass: findings and corrections

| Finding | Correction |
| --- | --- |
| Runtime port and `.env` behavior disagreed. | Startup now loads an optional root `.env` once, validates settings and consistently defaults the API to `127.0.0.1:4400`; Vite uses the same target. |
| Setup completion was split between browser storage and server state. | SQLite settings/profile state is authoritative; the browser asks `/setup/status`. |
| Ollama detection only proved reachability. | Preflight now checks version, exact installed model metadata, Q4_K_M/license/capabilities, strict JSON output, a bounded tool canary and `/api/ps` residency. |
| `sessionId` and idempotency were declarative only. | Migration 5 adds durable sessions/messages and idempotency claims. The core now supports replay, conflict detection and ordered context. |
| Unknown availability was grouped with unavailable. | Contracts require separate `available`, `unavailable` and `unverified` groups and explicit `mode`. |
| Preview playback wrote false Library/History state. | Preview Play is disabled. A live provider must return a validated future-expiring grant before the transactional state write. |
| Direct provider URLs had no safe lifecycle. | Webshare creates an in-memory, one-active-stream ticket; only the same-origin grant path reaches application state. |
| Provider extension points were marker interfaces. | Full typed metadata, media, subtitle, search, agent and sync contracts, provenance and a family-scoped registry are exported. |
| Unknown profile reads could create profiles and exhaust the five-profile cap. | Reads now return `PROFILE_NOT_FOUND`; only explicit setup creates/updates a profile. |
| Continue Watching used fixture progress and discovered titles did not feed Home. | Progress comes only from Library state and Home receives the complete sparse local canonical cache. |
| History was read-only and Library controls were incomplete. | Single-event removal, confirmed clear, filters, loading/error states and accessible dialog behavior were added. |
| `lint` performed no linting and web type checks were indirect. | ESLint 9 with TypeScript/React Hooks rules and an explicit web `typecheck` script are part of `pnpm check`. |

## Second pass: invariants rechecked

- Provider output is parsed before persistence; live responses require field
  provenance and valid availability/series coverage.
- A claimed discovery request is completed only with its durable assistant
  message and response. Failures leave a stable failed claim instead of an
  indefinitely in-progress request.
- Replaying the same idempotency body returns the same response; a changed body
  with the same key returns `409`.
- Playback does not mutate Library or History in preview mode, for an
  unavailable title, after an expired/mismatched grant, or with an insecure
  non-loopback URL.
- Secret values are resolved only inside transports, are absent from public
  integration objects and are covered by sentinel tests.
- Webshare HTTP 200 error XML, provider restrictions and link-host allowlisting
  are rejected.
- Local AI calls are server-side, bounded and schema-oriented; no arbitrary
  Ollama proxy is exposed to the browser.
- Home remains populated in preview/offline development, while preview mode is
  visible and cannot masquerade as live provider truth.

## Adaptive-theme implementation checks (2026-10-20)

The focused web suites pass 66 tests covering the clock, calendar/weather
resolver, storage, shared provider, Settings, onboarding and App integration.
This includes Prague/Lord Howe DST gaps and repeats, Samoa's skipped date,
manual clock advancement, corrupt/future caches, independent profile save queues,
late replies, denied/late geolocation, and successful/failed/cancelled onboarding.
The profile and environment server suites pass 23 tests, including partial
appearance patches, provider normalization, bounded requests/cache/queues,
throttling and failure recovery. All 18 contract and 8 database tests pass.

All four packages pass TypeScript checks. Changed TypeScript/CSS files pass
formatting and changed TypeScript files pass ESLint with zero warnings. Server
and database emit builds and the web production/PWA build pass. Node commands
were used directly because pnpm is absent from PATH; isolated caches/build
outputs under `.flight` avoid permissions on existing generated artifacts.

A headless Chrome flight using a separate in-memory server verified live
onboarding preview and saved appearance, profile chooser medallions, Cinematic,
profile activation, and Settings/top-bar synchronization. Emulated 390 px and
320 px layouts have no document-level horizontal overflow. Deterministic
provider fixtures exercised rain, fog, snow and clear backgrounds; reduced
motion hides the particle canvas. Screenshots are retained in the ignored
`.flight/adaptive-*.png` files. A separate live Open-Meteo adapter smoke test
received HTTP 200 for geocoding and forecast, normalized Prague results and
absolute solar instants. It required network access outside the execution
sandbox; the application handles blocked provider access as unavailable.

The full workspace checks still expose existing failures in unchanged areas:

- Four web tests fail in `IntegrationManager.test.tsx` and
  `TitleDetail.test.tsx`: outdated profile arguments, searching-label copy and
  an obsolete optional download argument.
- Six server tests fail in `external-subtitles.test.ts`,
  `provider-clients.test.ts`, `playback-media.test.ts` and `system.test.ts`:
  older provider mocks lack `forProfile`, an expected subtitle argument is
  outdated, and the integration-count assertion expects 12 rather than 16.
- Whole-repository ESLint reports six existing hook warnings in DownloadPage,
  HomePage and TitleDetail. Whole-repository formatting also finds existing
  differences in unrelated files.

These failures are outside the theme implementation and have not been hidden by
changing their expectations. Real-phone frame cost remains a hardware acceptance
check; desktop/mobile emulation establishes layout and behavior, not physical
device performance. The renderer enforces particle/DPR/FPS limits and pauses for
hidden pages, playback, reduced motion or sustained slow frames.

## Festive themes and manual appearance controls (2026-10-21)

The updated focused web suites and App regression suite pass 125 tests. They
cover every weather/daylight override, independent holiday snow, bounded
firework math, renderer pause/reduced-motion behavior, profile persistence,
onboarding preview/save/cancel, and fixing all three appearance axes. Settings
tests verify that a fixed look survives clock changes and a Cinematic roundtrip,
while automatic reset restores calendar/weather/daylight resolution. The two
profile/environment server suites pass 25 tests and all 21 contract tests pass.

Web, server and contract TypeScript checks pass. All changed TypeScript files
pass ESLint with zero warnings, changed TypeScript/CSS files pass Prettier, and
`git diff --check` passes. The web production build, including the generated PWA
service worker, succeeds in `.flight/festive-web-build`.

An isolated headless Chrome flight against the in-memory preview server verified
Christmas lights/snow, New Year fireworks/snow, onboarding persistence, and the
two-option Seasonal/Cinematic selectors in both headers. All six manual weather
conditions worked without a location or weather request. The flight also checked
fixing the current look, preserving its settings through Cinematic, automatic
reset, reduced-motion rendering, and 390 px/320 px layouts without horizontal
overflow. No uncaught browser exceptions occurred. Inspected screenshots are in
the ignored `.flight/festive-*.png` files. Real-phone frame cost remains an
external hardware check. The unrelated whole-workspace failures recorded above
remain outside this change; those broad suites were not rerun for this update.

## Glass weather and Appearance layout checks (2026-10-21)

The focused web and App regression suites pass 151 tests, including bounded
glass-droplet/snowflake lifecycles, frost accumulation, lightning envelopes and
cadence, scene continuity across clock ticks and playback pauses, live Settings
seconds without ambient rerenders, lock/unlock behavior, nested heading
structure, real weather freshness and separate visual previews. Profile and
environment server suites pass 26 tests; all 24 contract tests pass, including
optional city metadata and legacy location compatibility.

Web/server TypeScript checks pass. Changed TypeScript files pass ESLint with
zero warnings and changed TypeScript/CSS files pass Prettier. The web/PWA
production build succeeds in `.flight/glass-web-build`. The unrelated broad
workspace failures listed above were not rerun for this refinement.

An isolated headless Chrome flight against an in-memory fixture server inspected
rain beads/impact trails, denser storm rain and background illumination, sticking
snow and the refined irregular frost. It verified the Appearance hierarchy,
pressed lock toggle, per-second clock, actual city metadata/conditions separated
from the Snow preview, gray notes/attribution links, and 44 px crosshair beside
city search. Desktop and 390 px/320 px layouts have no horizontal overflow;
reduced motion hides the animated canvas and retains static frost. An emulated
geolocation click selected rounded coordinates successfully. Screenshots remain
in ignored `.flight/glass-*.png` files. No uncaught application exceptions were
observed. Physical-phone frame cost remains a hardware acceptance check.

City search supplies place name, administrative address and country where the
provider has them. Device GPS uses coarse coordinates and explicitly unavailable
country metadata. An optional reverse-geocoding proposal was rejected by
automatic approval review because sending coordinates to a new external
provider lacked specific user authorization. No reverse route/client or unused
implementation is included, and no coordinates were sent to that provider.
The concrete optional data flow requiring approval is: after an explicit
Use my location click, send latitude/longitude rounded to two decimals and the
selected language, via the home server, to
`https://nominatim.openstreetmap.org/reverse` at city detail (`zoom=10`). The
[Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
requires an identifying User-Agent, aggregate limit of one request per second,
caching, attribution and a switchable endpoint. The existing GPS weather path
continues working without this addition.

## External release gates still open

These need authorized accounts, hardware or an infrastructure decision and are
therefore intentionally not simulated:

1. Finish the Webshare playback acceptance spike with Range, seeking, ticket
   TTL, codec and restriction tests. The authorized VIP account has now passed
   guided login, live search, `file_info` inspection and format normalization.
   This flight also found and fixed a contract mismatch: `file_info` reports
   availability in `<available>`, not `<downloadable>`.
2. Run backup/restore and key-loss drills for the implemented portable
   AES-256-GCM `SecretStore`. Its Docker key is separate from the persistent
   application volume and production startup rejects the memory fallback.
3. Keep the Docker/Ollama flight in the release checklist. The first container
   acceptance run passed on 2026-09-29: the private server became healthy, the
   web gateway served the PWA on port 8080 and `host.docker.internal` reached
   Ollama `0.34.4` with explicit `qwen3.5:4b`. All six checks passed with 4.7B
   Q4_K_M, 4096 context tokens, tools and structured output working, and
   3,128,038,521 bytes reported resident in VRAM. The cold container preflight
   took about 10.49 seconds, within the 60-second deployment timeout.
4. Add the selected subtitle/search providers and optional Cloudflare sync only
   after their separate compliance and privacy gates.
5. Repeat desktop/mobile visual checks after material UI changes. The first
   production-Compose pass completed at desktop width and an emulated 390 px
   viewport with no document-level horizontal overflow. The in-app browser
   control surface was unavailable, so the same installed Edge engine was
   driven through its local debugging protocol instead.

The full automated command for the in-repository checks is `pnpm check`.
