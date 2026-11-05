# StreamerAI integration architecture

> Owner-approved recovery extension (2026-11-05): the explicit portable
> credential allowlist may be exported through the separately versioned E2EE
> household format and full encrypted offline server backups described in
> [DEPLOY_PLAN.md](../docs/DEPLOY_PLAN.md), sections 5A/5B. Only authorized local
> servers may decrypt those records; the cloud stores authenticated ciphertext.
> This exception does not allow secrets in legacy sync, model input, public
> API responses, diagnostics or profile transfers to another account. Provider
> expiry/device-binding constraints still apply. Current implementation and
> omissions are documented in [ENCRYPTED_HOUSEHOLD.md](../docs/ENCRYPTED_HOUSEHOLD.md).

This document is a mandatory developer contract. StreamerAI must support adding
metadata databases, media/streaming services, subtitle sources, web-search
providers, inference runtimes and sync backends without rewriting domain or UI
logic.

## 1. Core rules

1. Domain code depends on capabilities and normalized records, never a provider
   SDK, response shape or provider name.
2. Provider code lives in an infrastructure adapter behind a typed interface.
3. Internal entities use StreamerAI IDs. External identifiers live in a mapping
   table keyed by `provider_id + external_id + entity_type`.
4. No domain table uses a TMDB, ČSFD or Webshare ID as its primary key.
5. Credentials are resolved only at the adapter boundary through
   `SecretStore`; interfaces receive opaque secret references or an authorized
   request context, never credentials from domain objects.
6. Every external value carries provider, retrieval time, connector version,
   confidence/validation state and expiry where applicable.
7. An adapter cannot bypass the validation pipeline merely because it is the
   default provider.
8. UI copy and setup forms are driven by public adapter descriptors and
   capabilities, not hard-coded provider conditionals.

Avoid code such as:

```ts
if (provider === "webshare") { /* domain behavior */ }
```

Prefer capability dispatch:

```ts
const mediaProvider = mediaProviders.require(providerId);
const results = await mediaProvider.search(normalizedRequest, context);
```

Provider-specific optimizations may exist inside an adapter, never in the core
discovery, library, playback or history services.

## 2. Adapter families

### MetadataProvider

```ts
interface MetadataProvider {
  descriptor(): MetadataProviderDescriptor;
  health(context: ProviderContext): Promise<ProviderHealth>;
  search(query: MetadataSearchQuery, context: ProviderContext): Promise<MetadataCandidate[]>;
  getTitle(ref: ExternalEntityRef, context: ProviderContext): Promise<CanonicalTitlePayload>;
  getSeriesStructure(ref: ExternalEntityRef, context: ProviderContext): Promise<SeriesStructure>;
  getRatings(ref: ExternalEntityRef, context: ProviderContext): Promise<SourceRating[]>;
  getFeed(request: DiscoveryFeedRequest, context: ProviderContext): Promise<MetadataCandidate[]>;
}
```

Capabilities declare supported entity types, locales, ratings, artwork, people,
release feeds, trending feeds and series depth. TMDB is the first canonical
implementation; ČSFD is an optional enrichment adapter. The resolver must work
when future providers expose only a subset.

### MediaProvider

```ts
interface MediaProvider {
  descriptor(): MediaProviderDescriptor;
  health(context: ProviderContext): Promise<ProviderHealth>;
  search(request: MediaSearchRequest, context: ProviderContext): Promise<MediaCandidate[]>;
  inspect(candidate: MediaCandidateRef, context: ProviderContext): Promise<MediaVariant>;
  createPlayback(request: PlaybackRequest, context: ProviderContext): Promise<PlaybackGrant>;
}
```

Capabilities include films, series, episode search, direct links, HTTP Range,
containers, codec metadata, subtitle metadata and optional remux/transcode
support. `PlaybackGrant` is short-lived and must never be stored in the
canonical title or Library record.

Webshare is the first adapter, not a domain assumption. A future NAS, Jellyfin,
Plex, S3-compatible store or another authorized service implements the same
contract.

### SubtitleProvider

```ts
interface SubtitleProvider {
  descriptor(): SubtitleProviderDescriptor;
  health(context: ProviderContext): Promise<ProviderHealth>;
  search(request: SubtitleSearchRequest, context: ProviderContext): Promise<SubtitleCandidate[]>;
  fetch(candidate: SubtitleCandidateRef, context: ProviderContext): Promise<SubtitleAsset>;
}
```

Subtitle resolution priority:

1. embedded subtitle tracks reported by the selected media variant;
2. exact external match by approved media hash/identifier where supported;
3. deterministic canonical title, year, season/episode, release and language
   match;
4. model-assisted reranking of a bounded candidate set;
5. explicit manual user selection.

The model must not invent subtitle text, language, release compatibility or
timing. Automatic subtitle generation, translation or retiming is a separate
future capability with an explicit quality/privacy review.

No default external subtitle provider has been selected yet. The first
implementation must therefore ship the interface, embedded-track support and a
disabled external-provider slot rather than coupling the product to an
unapproved scraper.

### SearchProvider

Provides bounded web/news discovery results with URL provenance, query budgets,
host policy, caching and content sanitization. It never exposes a general URL
fetch tool to the model.

### AgentProvider

Provides health, capability negotiation and strict structured generation.
Prompts, tools, validation and policies remain owned by StreamerAI, not by the
runtime adapter.

### SyncProvider

Implements the versioned push/pull/snapshot protocol. Domain repositories never
import Cloudflare bindings or D1-specific types.

## 3. Normalized capability model

Every adapter registers a public descriptor:

```text
id
family
display_name
connector_version
capabilities[]
supported_locales[]
setup_mode
credential_fields[]
can_auto_detect
supports_recheck
supports_disconnect
documentation_url
privacy_summary
```

Capabilities are negotiated at startup and cached with the adapter version.
Unsupported features are disabled or degraded in the UI; they are not simulated
by prompt instructions.

Registry lookup is dependency-injected. Tests can register fake adapters without
network access, and installations may choose a different default adapter without
changing domain code.

## 4. Guided setup lifecycle

All integrations follow the same application-driven lifecycle:

1. **Discover** — auto-detect a local endpoint where possible.
2. **Explain** — show purpose, data flow, permissions and whether it is optional.
3. **Configure** — render the adapter's validated setup schema.
4. **Verify** — perform a bounded read-only connection/capability test.
5. **Connect** — save secrets through `SecretStore` and sanitized state in
   SQLite only after verification succeeds.
6. **Monitor** — expose last success, latency, version and actionable health
   codes.
7. **Recheck** — allow an explicit safe retry.
8. **Disconnect** — revoke/delete secrets and private provider cache without
   deleting unrelated Library or History data.

The normal household experience must not require editing `.env`, Compose or
JSON. Environment settings are developer/deployment overrides only.

## 5. Errors and resilience

Adapters translate provider failures into stable error categories:

```text
INVALID_CREDENTIALS
PERMISSION_MISSING
RATE_LIMITED
NETWORK_UNREACHABLE
PROVIDER_UNAVAILABLE
INVALID_RESPONSE
UNSUPPORTED_CAPABILITY
CONTENT_RESTRICTED
NOT_FOUND
UNKNOWN
```

Each call has a timeout, cancellation, bounded retries with jitter, rate limit,
cache policy and circuit breaker. Raw upstream messages and payloads are
diagnostic data; they are redacted and never used directly as localized UI copy
or model instructions.

Provider outage and a valid empty result are distinct. For example, a failed
media-provider request produces `availability=unknown`, while a successful
search with no admissible variants may produce `availability=unavailable`.

## 6. Provenance and merge policy

Normalized fields retain independent provenance. Adding a second database does
not overwrite an entire canonical record.

- Stable identity fields follow configured source precedence and confidence.
- Ratings remain separate per source and scale; they are never silently averaged.
- Localized titles can coexist.
- Artwork retains source attribution and expiry.
- Manual user corrections have highest local precedence and an audit event.
- Availability always belongs to a media provider and check timestamp.
- Subtitle assets retain provider, language, format, release match and checksum.

The agent receives only the merged, allowed fact projection and source labels.

## 7. UI extension rules

- Generic components render descriptors, health and capabilities.
- Provider branding is optional data supplied by the adapter and cannot change
  layout or security policy.
- A rating chip always names its metadata source.
- Availability text names the selected media service where useful.
- Alternate media and subtitle providers appear in the same overflow/detail
  surfaces as the defaults.
- Library membership is provider-independent. Switching a media adapter keeps
  saved titles, history and canonical identity mappings.

## 8. Contract tests

Every adapter must pass the same family-level suite plus provider fixtures:

- descriptor and capability-schema validation;
- setup success, invalid credential, timeout, rate limit and malformed response;
- proof that credentials and secret references never enter public responses,
  logs, prompts, sync or snapshots;
- normalization and provenance fixtures;
- cancellation, retry, cache and circuit-breaker behavior;
- empty result versus provider failure;
- disconnect and secret deletion;
- upgrade/migration from the previous connector version;
- malicious text/filename/subtitle payloads treated as untrusted data.

Media adapters additionally test film, episode, alternate formats and current
availability. Metadata adapters test remakes, localized names and series
structure. Subtitle adapters test language, episode, release, hash/checksum and
archive/path safety.

## 9. Adding an integration

A new integration is complete only when it provides:

- adapter implementation and public descriptor;
- normalized mapping with no provider-specific leakage into domain types;
- guided setup, verify, health, recheck and disconnect;
- secret-store integration and redaction tests;
- cache/rate/circuit-breaker policy;
- provenance and migration behavior;
- contract fixtures and offline degradation;
- English, Czech and German setup/error copy;
- source terms, attribution and authorization review.

Default-provider selection is configuration. It is never permission to add
provider-specific shortcuts to core services.
