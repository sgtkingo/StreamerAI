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
- Google account login, TV pairing by QR/code, up to five profiles per account,
  optional local profile PINs and Cloudflare Workers/D1 user-state sync.
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

Open `http://localhost:8080`. Compose keeps the API private, persists SQLite and
the encrypted credential vault in a named volume, and reaches host-native
Ollama through `host.docker.internal`. The master key stays in the ignored
`.secrets` directory and must be backed up separately.

The web application is served by Vite during development and forwards `/api`
requests to the local server. Copy `.env.example` to `.env` only for non-secret
runtime overrides. Provider keys and passwords belong in the guided setup flow,
not in environment files or source control.

To enable Google accounts, set `STREAMERAI_ACCOUNT_SERVICE_URL` to the deployed
identity Worker and restart the server. See [account setup and migration](docs/ACCOUNTS.md)
and [Cloudflare deployment](docs/CLOUD_AUTH.md). Leaving it empty retains trusted
local operation. With cloud accounts configured, **Continue locally** also
opens an isolated household without registration. Online accounts support Google
and e-mail codes; synchronization can be paused independently. Apple and Google
Drive remain planned.

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
