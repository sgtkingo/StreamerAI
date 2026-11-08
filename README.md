# StreamerAI

StreamerAI is a local-first, self-hosted film and series discovery application.
The user describes a mood, person, era or viewing context; a bounded agent
proposes candidates, while deterministic adapters validate metadata and media
availability before anything is shown as factual or playable.

The repository is at the first implementation milestone. The approved product,
deployment and agent decisions live in [`instructions/`](instructions/).

## Current milestone

- TypeScript/pnpm monorepo.
- React/Vite installable web application with conversational Home, Library,
  Watch History and guided onboarding.
- Fastify local API with Home, discovery, Library, History, health and setup
  endpoints.
- SQLite persistence in WAL mode for profiles, an on-demand canonical cache,
  provider ID mappings, durable discovery sessions/idempotency, Library and
  editable History.
- TMDB connection verification designed around an in-app guided setup flow.
- One household per home server, with up to five profiles, local QR/code or
  Master PIN pairing, and optional Cloudflare Workers/D1 sync and encrypted backups.
- Separate household administration at `/admin`, plus thin Windows, Linux,
  macOS and Android/Android TV clients that discover and open the home server.
- Provider-neutral contracts and registries, TMDB metadata, guided Webshare
  authentication, an optional authenticated Hellspy stream adapter, an FFmpeg-backed in-app player and Ollama structured-agent
  adapters.

The development feed is explicitly labeled as preview data and cannot create
playback history. Live Webshare playback now has an integrated player, but its
real-account codec, seeking and subtitle checks remain release gates. Real TV
and two-account Google acceptance checks are described in
[`docs/ACCOUNTS.md`](docs/ACCOUNTS.md). The complete autonomous discovery pipeline remains future work in
[`instructions/DEPLOY.md`](instructions/DEPLOY.md).

## Prerequisites

- Node.js 24.7 or newer, below 26 (Node.js 24 LTS is the deployment target).
- pnpm 10.
- FFmpeg and FFprobe for local development (the server Docker image installs both).

Install pnpm if it is not already available:

```sh
npm install --global pnpm@10.17.1
```

Then install and run the workspace:

```sh
pnpm install
pnpm dev
```

For the Docker deployment (the recommended home-server profile), generate the
local encryption key once and start Compose:

```sh
node scripts/generate-master-key.mjs
docker compose up --build
```

Open `http://localhost:8080/admin` to create or import the household.
The viewing application remains at `http://localhost:8080/`.
Compose keeps the HTTP API behind the web proxy, persists SQLite and
the encrypted credential vault in a named volume, and reaches host-native
Ollama through `host.docker.internal`. The master key stays in the ignored
`.secrets` directory and must be backed up separately.

On a server without a household, `/admin` opens **Set up your household** directly:
create a household, import a file, or restore from the cloud. New households
require a new 8-digit Master PIN; either restore option requires the original
backup PIN. No installation key is required. Administration becomes available
after the PIN has been created or the backup has been decrypted successfully.
Additional clients request pairing and are approved
by the owner in `/admin`; the same pairing works with or without cloud management.
An 8-digit Master PIN can also authorize clients and household administrators.
An explicit `STREAMERAI_ACCESS_MODE=trusted-local` override retains trusted access
for isolated development or an existing deployment that requires it.

The web application is served by Vite during development and forwards `/api`
requests to the local server. Copy `.env.example` to `.env` only for non-secret
runtime overrides. Provider keys and passwords belong in the guided setup flow,
not in environment files or source control.

To enable Google accounts, set `STREAMERAI_ACCOUNT_SERVICE_URL` to the deployed
identity Worker and restart the server. See [account setup and migration](docs/ACCOUNTS.md)
and [Cloudflare deployment](docs/CLOUD_AUTH.md). Leaving it empty keeps the
household on the home server without cloud management. Online accounts support
Google and e-mail codes. Apple and Google Drive remain planned.

The household owns its profiles, shared services and Master PIN. Connecting or
disconnecting cloud management preserves its identity, data and paired clients.
A cloud account can manage several households. Creating a household asks for a
new Master PIN; importing one asks for the existing backup PIN. Cloud login can
select and restore an existing household. The PIN stays in the home server's
encrypted credential vault, and is never uploaded to the cloud.

Automatic local backups default to once an hour under
`data/household-backups/<household-id>/`. Cloud backups use the same Master PIN;
both schedules can be changed in household administration. Portable backups
include profiles, viewing data, conversations and shared provider credentials;
media files, AI models, local paths and device authorizations require separate
server backups. Structured cloud synchronization contains allowlisted profile
and viewing records; encrypted backups are a separate channel.

Native clients, installation/build commands and Android TV notes are documented
in [apps/client/README.md](apps/client/README.md). LAN discovery uses UDP port
47777, verifies the discovered server identity over HTTP, and offers manual
server selection when multicast/broadcast is unavailable. In Docker, set
`STREAMERAI_ADVERTISE_URL` to the home server's reachable web address, for example
`http://192.168.1.20:8080`, rather than its container address. A reverse proxy
using HTTPS should also set `STREAMERAI_WEB_ORIGIN` to that public HTTPS origin.

This branch's cloud API requires D1 migration `0011_households.sql` and the
matching Worker version; migration and production deployment are separate
operator steps. See [the household architecture](docs/HOUSEHOLD_SERVER_CLIENT.md).

## Quality checks

```sh
pnpm check
```

This runs formatting validation, ESLint, type checks, unit tests
and production builds.

## Security baseline

- The browser never talks directly to Ollama or provider APIs.
- Public integration state never contains credentials or secret references.
- A connection is tested before it is saved.
- Local use remains available when metadata, AI or sync providers are offline.
- Automated web access is implemented only behind an explicitly authorized,
  rate-limited provider adapter.

See [`instructions/DEPLOY.md`](instructions/DEPLOY.md) and
[`instructions/LOCAL_AGENT.md`](instructions/LOCAL_AGENT.md) for the complete
threat boundaries and staged delivery plan.
