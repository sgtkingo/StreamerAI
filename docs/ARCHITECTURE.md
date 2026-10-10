# Architecture

StreamerAI is local-first. The browser is a presentation client; secrets,
provider traffic, validation, canonical identity and playback decisions stay
on the local server.

## Workspace

| Path | Responsibility |
| --- | --- |
| `apps/web` | React/Vite PWA, onboarding, Home, discovery results, Library and History. |
| `apps/server` | Fastify API, provider orchestration, safety boundaries and application services. |
| `packages/contracts` | Runtime Zod schemas and provider-neutral TypeScript contracts. |
| `packages/database` | SQLite migrations and repositories. |
| `instructions` | Approved product, deployment and integration specifications. |
| `docs` | Developer-facing description of the current implementation. |

## Request flow

```text
React UI
  -> Fastify route
    -> StreamerCore
      -> StreamerContentProvider (discovery coordinator)
        -> Agent/Search adapters propose candidates
        -> Metadata adapters resolve canonical identity and facts
        -> Media adapters verify availability and formats
      -> SQLite canonical cache, Library and History
    -> strict shared response schema
  -> tiles rendered from validated records only
```

`PreviewContentProvider` remains the explicit development/test fallback. The
production composition root now creates `LiveContentCoordinator` from Ollama,
TMDB and Webshare adapters; custom deployments can still inject another
implementation through `createApp({ contentProvider })` without changing
routes, Library or History.

Fine-grained adapters are registered through a family-scoped
`AdapterRegistry`. The repository now includes TMDB metadata normalization,
Webshare media normalization/ticket issuance and an Ollama structured-agent
adapter. The live coordinator checks sanitized integration state before a turn
and returns `needs-setup` instead of substituting preview facts when a required
provider is disconnected.

## Discovery boundary

The initial search now has two parallel lanes. A bounded fast lane queries the
metadata API directly, ranks title similarity deterministically and validates
its shortlist against the same metadata and media-provider pipeline as the
deep lane, without invoking a model. The deep lane runs the existing Ollama
proposal flow. Both share a discovery session; the UI merges their responses
by canonical title ID and Stop aborts only the deep lane. Fast records remain
available even when Ollama is unavailable. One merged "A considered shortlist"
keeps an exact-title Fast hit visible without duplicating it in a separate
Fast section.

The UI preserves an unambiguous Fast exact-title match ahead of unrelated
model suggestions, while Deep may improve the ranking of exploratory queries.
Fusion retains verified playback and alternate sources from either lane,
regardless of completion order. Fast hits with incomplete media checks stay
unknown or checking rather than being prematurely called unavailable. Fast
tries original/localized title queries with and without the year; reaching a
provider-result or inspection budget without a source is not a definitive
negative. If a later source check succeeds, the title is reclassified into
the playable group for the current view without rewriting the stored discovery
response or canonical title. The card reason is a user-facing explanation,
not an implementation placeholder. Already-validated Fast matches can inform
the agent when timing permits, but correct fusion never depends on that race.

The model is a planner and ranker, not a fact database. A live coordinator must
perform these stages:

1. Interpret the conversational request and profile preferences.
2. Gather candidate titles from bounded model/search tools.
3. Resolve each candidate through a deterministic metadata provider.
4. Assign or reuse an internal canonical ID and save external ID mappings.
5. Check media availability, formats and series coverage.
6. Remove unvalidated candidates from agent context.
7. Rank only validated records and return best match, available, unavailable
   and explicitly unverified groups.

Every completed discovery response is parsed against
`DiscoveryResponseSchema`. `StreamerCore` then upserts all returned records into
the canonical cache before the user can save or play them.

## Core invariants

- Internal IDs are provider-neutral. TMDB, CSFD and media IDs are mappings, not
  primary keys.
- The best match must be `available` or `partial`.
- `available` requires at least one verified media format.
- `unknown` and `unavailable` are different states.
- Movies cannot carry series coverage.
- Series completeness must match verified season and episode counts.
- Discovery groups cannot contain duplicate canonical IDs.
- Playback is rejected unless the current canonical record is playable and a
  live provider successfully performs a just-in-time recheck.
- Only after a valid short-lived grant exists does playback add/update Library
  membership and append History in one SQLite transaction.
- Preview fixtures can never create playback history.
- Provider credentials never enter shared media records, browser state, logs or
  sync payloads.

These rules are runtime-validated in `packages/contracts/src/media.ts`, not
only expressed as TypeScript types.

## Persistence

SQLite runs in WAL mode. The default development file is
`data/streamer-ai.db`; tests use an in-memory database. Important tables are:

- `canonical_titles` - sparse, on-demand validated title cache;
- `external_entity_mappings` - provider IDs and provenance;
- `library_entries` - per-profile saved/in-progress/completed state;
- `watch_history_events` - append-only playback history;
- `discovery_sessions` and `discovery_messages` - durable conversation state;
- `idempotency_records` - request ownership, replay and collision detection;
- profiles, settings, jobs and integration status tables from earlier
  migrations.

The canonical cache is not intended to become a full mirrored film database.
Refresh metadata and availability according to provider-specific TTLs while
preserving local Library and History state.

## Agent instructions and conversation memory

The application agent does not load `SOUL.md`, `SKILLS.md` or `MEMORY.md` at
runtime. Its instructions and structured output contract live in the discovery
coordinator. Discovery messages are stored per session in SQLite. Before each
model call, older user requests are condensed into a short summary and recent
turns are bounded by the configured inference context size. The full local
session remains available for later turns.

For requests for something the viewer has not seen, discovery asks for a list
before recommending. The reply and the profile's playback history become
exclusions. The coordinator receives the exclusion names as context, and the
core filters validated titles by canonical ID and normalized title before
sending the response. The fast discovery lane follows the same rule.

## Failure model

External systems are optional failure domains. Metadata, media, AI, search or
sync downtime must not prevent access to already cached local data. Adapter
errors are translated to stable public codes; raw upstream responses remain
server-side and redacted.

The default integration-state store is SQLite, while development secrets remain
memory-only and are reported as such. Production startup rejects any
non-persistent or unencrypted secret store. A durable OS-keychain/external
secret adapter is a release gate, not something to work around with environment
variables.
