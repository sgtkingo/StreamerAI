# Development guide

## Prerequisites

- Node.js 24.7-25 (Node.js 24 LTS is the deployment target; offline backup uses built-in Argon2)
- pnpm 10.17.1 or another pnpm 10 release

```sh
pnpm install
pnpm dev
```

The default development endpoints are:

- web: `http://localhost:5173`
- API: `http://127.0.0.1:4400`
- Ollama probe: `http://127.0.0.1:11434`

Vite proxies `/api` to the local API. The browser must not call provider APIs
or Ollama directly.

## Configuration

Copy `.env.example` to `.env` only for non-secret local overrides. Supported
settings currently documented there include the server host, port, data path,
web origin, log level and local Ollama defaults.

Provider credentials are entered through guided setup and belong in a
`SecretStore`. Do not put real tokens in `.env`, fixtures, screenshots, logs or
commits.

Development defaults to a non-persistent memory store for credentials and a
persistent SQLite integration-state store. Docker production uses the included
AES-256-GCM file vault. Its 32-byte master key is mounted separately as a
read-only Docker secret, never stored in SQLite, the vault or `.env`. The API
reports the actual persistence capabilities and production refuses to start
with the memory fallback.

## Docker home-server profile

Generate the installation key without printing it:

```sh
node scripts/generate-master-key.mjs
docker compose up --build
```

The generator refuses to overwrite an existing key. Back up both the Docker
data volume and `.secrets/streamerai_master_key`; losing the key makes saved
provider credentials intentionally unrecoverable. Do not copy the key into the
data volume or source control.

The default Compose profile expects host-native Ollama at
`http://host.docker.internal:11434` and the installed model
`qwen3.5:4b`. The API remains private behind nginx and the web app is
available at `http://localhost:8080`.

## Commands

```sh
pnpm dev             # web and server watch processes
pnpm format          # write Prettier formatting
pnpm format:check    # verify formatting
pnpm lint            # ESLint across the complete TypeScript workspace
pnpm typecheck       # strict TypeScript checks
pnpm test            # all unit/component/API tests
pnpm build           # production builds
pnpm check           # full required validation sequence
```

Run one workspace when iterating:

```sh
pnpm --filter @streamer-ai/server test
pnpm --filter @streamer-ai/web test
pnpm --filter @streamer-ai/database test
pnpm --filter @streamer-ai/contracts test
```

## Safe development loop

1. Read the relevant file in `instructions` and identify its invariants.
2. Change or add a shared Zod contract before changing both API and UI shapes.
3. Keep network/provider logic behind an adapter or content coordinator.
4. Add failure-path tests, especially for secrets, availability and incomplete
   series.
5. Run the focused test while iterating, then run `pnpm check` before handoff.
6. For UI changes, exercise onboarding, Home search, add/remove Library,
   playback and History in a real browser at desktop and narrow widths.

## Database changes

Add an append-only migration in `packages/database/src/migrations.ts`. Never
rewrite a released migration. Repository code belongs in
`packages/database/src/repositories.ts`; expose it through `StreamerDatabase`
and test both persistence and domain constraints.

Use internal canonical IDs for foreign keys. Provider-specific IDs belong in
`external_entity_mappings`.

Discovery changes must also preserve `discovery_sessions`, ordered messages and
`idempotency_records`. Never acknowledge an idempotent request before its
assistant result and replay record are durable.

## API and contract changes

- Parse external input at the route or adapter boundary.
- Parse coordinator output again before persistence.
- Return stable public error codes and safe messages.
- Do not forward upstream bodies to the web app.
- Keep requests idempotent where retries can create work or state.
- Update [`API.md`](API.md) when an endpoint changes.

## Definition of done

A change is complete when its success, degraded and unsafe paths are covered;
the UI remains usable with optional providers offline; no secret can appear in
responses or logs; developer documentation reflects the implementation; and
`pnpm check` passes.
