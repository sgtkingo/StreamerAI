# Agent and MCP integration

## Resulting architecture

```text
External MCP host --stdio--> StreamerAI MCP bridge --loopback HTTP--> StreamerAI API
                                                               |
                                                  StreamerCore / LiveContentCoordinator
                                                               |
                                         AgentRouter --> Ollama/Custom/remote API | local Codex | local Claude
                                                               |
                                                   metadata and media validators
```

The MCP bridge calls the same application routes used by the web UI. Its tool
dispatcher strips source URLs, credentials, playback ticket paths, and provider
payloads. Discovery still goes through the existing compact, balanced, or
extended instruction policy, followed by canonical metadata and media checks.
Codex, Claude, and remote API models use balanced instructions by default and
extended instructions for capable model families such as Astra, Opus, and Pro;
the Ollama policy remains based on model size and token budget. Reasoning effort
does not change the search ruleset. Each profile stores one selected
backend. The local host switches between Codex and Claude and closes sessions
from the previous provider when preferences change.

The existing `AgentProvider.generateStructured()` remains the boundary used by
the coordinator. `AgentRouter` chooses a backend per profile. `AgentSession`
adds `sendMessage()`, `streamEvents()`, `cancel()`, and `closeSession()` to the
local host. Codex uses a persistent app-server process and thread IDs. Claude
uses its documented noninteractive CLI with streamed JSON and `--resume` IDs;
each Claude turn starts a CLI process. Session IDs are stored in SQLite for
continuation across StreamerAI restarts. The CLI remains responsible for its
own sign-in. StreamerAI never reads or copies CLI credential files.

## Configuration and status

`STREAMERAI_AGENT_MODE=api|local|mcp|disabled` and
`STREAMERAI_AGENT_PROVIDER=ollama|custom|openai|anthropic|gemini|grok|kimi|deepseek|codex|claude`
set defaults. Model selection is automatic unless `STREAMERAI_AGENT_MODEL`
names a specific model. `STREAMERAI_AGENT_REASONING_EFFORT=none|low|medium|high`
defaults to `low`.
Each profile
can select one of these or `disabled` with
`PUT /api/v1/inference/selection` and inspect status with
`GET /api/v1/inference/selection?profileId=default`. Example body:

```json
{"profileId":"default","mode":"local","provider":"codex","reasoningEffort":"low"}
```

Settings and Onboarding show one active choice across Local Agent and External
Agent. External Agent switches between API and MCP. Selecting MCP stores
`{"mode":"mcp","provider":"ollama"}` as a profile preference; `ollama` is
only a compatibility placeholder in that payload. MCP does not start an
embedded agent, and status reports `MCP_HOST_REQUIRED` because StreamerAI
does not currently detect whether an external host has connected. The thinking slider is controlled by the external
host in this mode. The Local Agent card offers Ollama and Custom, a local
OpenAI-compatible server. Discover lists all models reported by Ollama's
`/api/tags` and Custom's `/v1/models`; Auto prefers a ready Ollama and then
Custom. The actions use local readiness from
`GET /api/v1/inference/local-providers?profileId=default`. The endpoint also
reports Codex and Claude Code CLI readiness for programmatic integrations.
The same floating guide is available in Settings and the AI agent onboarding
step. It scans local providers and installed models when the user enters the
local connection step, then checks Ollama with a preflight if needed. Custom
must also complete a small structured test request through
`POST /api/v1/inference/custom/verify` before the guide recommends it. If Ollama
is not running it links to the official installer. If its configured model is
missing, the user can explicitly start a download with
`POST /api/v1/inference/agent/pull`; the server pulls only the model and URL
from the validated profile configuration and verifies the connection afterward.
`GET /api/v1/inference/agent/ollama-config` lets the guide show that model even
when an external provider is currently selected.
`POST /api/v1/inference/agent/verify` checks an installed Ollama model without
changing the profile. The guide saves the chosen model through the connection
endpoint only when the user applies its recommendation.
The Custom verification endpoint also accepts a candidate local URL and model;
it validates and probes them without saving either value. The guide saves a
new Custom connection only after the user applies it.
The download uses a single request with a ten-minute server timeout and does
not currently report byte progress. For external API mode, the guide collects
the provider and API key itself, or uses a saved key for the chosen provider.
It saves its recommendation only when the selected connection is ready.

Custom settings store a profile-specific base URL and model with
`PUT /api/v1/inference/custom`, for example
`{"profileId":"default","baseUrl":"http://127.0.0.1:1234/v1","model":"local-fast"}`.
Only local or private HTTP(S) hosts are accepted; URL credentials, query
strings, and redirects are rejected. The connector does not read or store
API keys. It sends structured requests to `/v1/chat/completions` without a
reasoning parameter, so its thinking level is `none`. The local server must
support the OpenAI-compatible JSON response format.

For a remote API, first store a key with `PUT /api/v1/inference/api-credential`
using `{ "profileId": "default", "provider": "openai", "apiKey": "..." }`, then
select it with `{ "mode": "api", "provider": "openai" }`. Omitting `model`
selects a fast low-cost option from models returned by the provider for that
account. `GET /api/v1/inference/models?profileId=default&provider=openai&reasoningEffort=low`
returns `models` with supported `reasoningEfforts`, `recommendedModel`, and a
`source`/`status` pair. Before credentials exist or if model discovery fails,
the catalog marks its documented suggestion `unverified`. Local and External
Settings each offer Automatic or an exact `model`; the shared thinking control
saves `reasoningEffort`. A verified incompatible combination is
rejected. The response to `GET /api/v1/inference/selection` includes the
effective model and effort when verified.
The API also supports GET status and DELETE for a key. It never returns the key.
OpenAI API billing and credentials are separate from a ChatGPT subscription.

The local status command invokes `codex login status` or `claude auth status` and
returns `READY`, `NOT_INSTALLED`, `NOT_AUTHENTICATED`, or a check error. It does
not print CLI output or credentials. The existing Ollama preflight remains the
readiness check for Ollama. The API key is stored separately from model access;
the selection status reports ready only after the provider's model catalog can
be read and the selected model is listed. A model catalog still does not prove
remaining quota or entitlement to each model. A missing selected agent degrades conversational
discovery while deterministic search remains available.

Codex model options and supported efforts come from app-server `model/list`.
Claude Code has no documented machine-readable model listing; its `haiku`
alias is shown as an unverified suggestion. Its CLI cannot guarantee that
`none` disables thinking, so StreamerAI uses `low` as the effective effort.
Gemini 3 Flash-Lite maps `none` to `minimal`, which may still think. Ollama
reads installed models from `/api/tags` and thinking values from `/api/show`.
The Speed–Quality control changes model reasoning only; the established
compact/balanced/extended discovery rulesets remain independent.

Settings and the final Onboarding step expose **Context window (tokens)**.
`PUT /api/v1/inference/selection` accepts optional integer `contextTokens`
(2048–131072), stored with the profile's agent selection. Omitting it resets to
Automatic: Ollama uses `INFERENCE_CONTEXT_TOKENS` (4096 by default), other
embedded backends use an 8192-token application budget. GET and PUT responses
include the saved `contextTokens` when set and `effectiveContextTokens`.
Ollama model catalog entries expose `maxContextTokens` when `/api/show` reports
`model_info[general.architecture + ".context_length"]`. The API rejects explicit
limits above the selected or automatically recommended model's known maximum;
runtime budgets also clamp older saved limits if that maximum changes. Missing
metadata leaves the model maximum unknown rather than inventing one.
The effective budget controls discovery history/candidate packing and output
reservation, and is sent to Ollama as `options.num_ctx` on generation and
preflight requests. Changes apply to subsequent requests without restarting.
For remote APIs and custom endpoints this is an application prompt budget;
it does not reconfigure the provider's physical context window. MCP hosts manage
their own context. Larger Ollama windows can increase RAM/VRAM use; Automatic
does not allocate the model's full advertised maximum.

For Automatic model selection, Settings and Onboarding resolve the same
recommended model before offering its thinking levels. An on/off model such as
`qwen3.5:4b` offers only `none` and `high`, mapped to Ollama's `think:false` and
`think:true`. A saved generic `low` preference enables thinking on an on/off
model; the UI displays the effective level reported by the backend. Named
thinking levels are sent only when the selected model reports them. Missing
thinking metadata leaves the runtime default unchanged and does not prove that
reasoning is disabled. Capability caches are scoped to the endpoint and model.
Enabled thinking receives a separate bounded allowance of up to 3072 generated
tokens, within the configured context and request deadline, so it does not
consume the entire final JSON allowance.
If a model supporting `think:false` exhausts that allowance before producing
valid JSON, the adapter allows one direct schema repair with thinking disabled,
using the same input and schema within the remaining deadline. It never replays
or logs hidden thinking, never retries recursively, and does not change the saved
effort. `DISCOVERY_AGENT_REPAIR_STARTED` and the per-call `phase`/`think` fields
make this fallback explicit in the logs.

## Grounded discovery for small models

Recognizing a genre is a retrieval step, not a completed interpretation of the
request. For a thematic request, the coordinator resolves a bounded shortlist
of canonical titles and descriptions, then asks every model tier to select
only IDs that fit the complete request and earlier preferences. This happens
before media searches. The model can return an empty selection; the application
then requests fresh title proposals instead of restoring popularity order.
Rejected titles cannot reappear through that fallback. Unknown or duplicate
IDs are rejected. Movies, series, and metadata providers share the retrieval
budget, and input text is bounded to the configured context. Requests with
genre exclusions use the proposal path to avoid treating a negative genre as a
positive catalog filter.

If the selected shortlist has no confirmed playable match, discovery makes one
additional title-proposal pass within the original deadline. Unknown,
unavailable, and incomplete series candidates are retained while alternatives
are checked. Already checked canonical IDs and title aliases are excluded from
the extra pass. Its compact schema requests only title and media kind for up
to three candidates; it does not ask a small model to also generate years,
acknowledgements, scores and explanations. An expansion failure preserves the
initial results; explicit cancellation still cancels the whole request. Complete-series requests continue
until complete playback is verified or the bounded expansion is exhausted.
The complete deep request has a fixed budget set when it starts: 55 seconds
with reasoning disabled, or at most 110 seconds with reasoning enabled to allow
both model steps. Individual inference calls retain their configured timeout;
the extra pass never resets or extends the request's deadline.
The web proxy allows 120 seconds for API responses so it does not cancel a
Quality request at Nginx's shorter default timeout.

Server logging is controlled by `STREAMERAI_LOG_LEVEL` at startup, both locally
and in Docker Compose. Supported levels are `trace`, `debug`, `info` (default),
`warn`, `error`, `fatal`, and `silent` (disables server logging). Each level
includes more severe events. `info` retains HTTP request logs and discovery
completion summaries; `warn` retains discovery failures and other warnings/errors.
Detailed structured `DISCOVERY_*` diagnostics require `debug` (or `trace`).
This setting controls the server logger; Nginx access logs are separate.
For detailed diagnosis, set `STREAMERAI_LOG_LEVEL=debug` in `.env` and run
`docker compose up -d server` to recreate the container with the new setting.
For a quiet release, use `STREAMERAI_LOG_LEVEL=warn` or `silent`.

`discoveryRequestId` links the user's idempotency key to HTTP `reqId`, and
`sessionId` links all events to the conversation stored in SQLite. Events record
the catalog queries and bounded result lists, exact facts passed to grounded
selection, selected IDs, fresh title proposals, actual Ollama model/`think`
settings and token usage, exact Webshare search terms, file filtering and
inspection outcomes, expansion decisions, and final availability reasons.
Exception messages, credentials, direct playback URLs, raw user prompts, model
responses and hidden thinking are excluded. The original request can be looked
up in the local conversation using the correlation IDs.

For a particular discovery request, PowerShell can filter the Docker logs:

```powershell
docker compose logs --no-color --since 15m server | Select-String '1792789319006-1'
```

The opt-in local quality evaluation uses the actual coordinator and installed
`qwen3.5:4b`, with in-memory catalog and playback fixtures. It covers both
reported English space queries, Czech/German equivalents, and expansion beyond
an unverified Hail Mary without using app credentials or contacting
metadata/media services. On PowerShell:

```powershell
$env:STREAMERAI_RUN_OLLAMA_EVAL = '1'
pnpm --filter @streamer-ai/server test -- tests/ollama-discovery.integration.test.ts
```

Set `STREAMERAI_OLLAMA_EVAL_REASONING=high` to evaluate the same path with
thinking enabled. The default is `none`; ordinary test runs skip these live
model evaluations.

Optional `STREAMERAI_CODEX_COMMAND` and `STREAMERAI_CLAUDE_COMMAND` select
executable paths. They are passed directly to `spawn()` with an argument array
and `shell: false`. On Windows, use a native `.exe` executable: a `.cmd` shim
cannot be executed by this launcher without a shell.

## MCP server

Build the server, start the StreamerAI API, then configure an external host to
launch `node <project>/apps/server/dist/mcp/stdio.js` as an MCP stdio server.
The five tools are `search_media`, `inspect_media`, `get_subtitles`,
`start_playback`, and `stop_playback`. The bridge defaults to
`http://127.0.0.1:4400`. For the Docker web proxy, set
`STREAMERAI_MCP_BASE_URL=http://127.0.0.1:8080` in the MCP bridge process.
The bridge accepts only loopback backend addresses.
`STREAMERAI_MCP_PROFILE_ID` binds an external bridge to one viewer profile
(`default` unless set). A tool call cannot select another profile through its
`profileId` argument. Subtitle and stop tools accept only playback grants
created by that bridge process.

`start_playback` creates a time-limited grant on the running StreamerAI server;
the user opens the title in the StreamerAI player. `stop_playback` revokes that
grant. `get_subtitles` lists track metadata for a grant, not subtitle text.
Direct media URLs stay inside StreamerAI.

## Deployment feasibility

| Deployment | MCP bridge | Embedded Codex/Claude | Notes |
| --- | --- | --- | --- |
| Native server under signed-in OS user | Yes | Yes | Recommended for local CLI mode. CLI sign-in is checked through each CLI. |
| Current Docker Compose server | Yes, via loopback web proxy | No by default | Container cannot see host CLI executable or host sign-in; do not mount credential files merely to make this work. |
| Remote shared server | Requires authenticated API boundary first | Not recommended with personal CLI sign-in | Current API is designed for local use. |

Compose publishes web port 8080 on host loopback. MCP stdio is not a network
listener. The server passes only a small allowlist of ordinary OS environment
variables to CLI children and starts them in an empty temporary directory.
Codex turns use a read-only sandbox with a restricted read root; Claude runs
with built-in and MCP tools denied. Prompts contain validated discovery context,
not StreamerAI vault entries or direct media URLs. Provider logs do not include
prompts or credentials.

## Known limits

- Custom supports local OpenAI-compatible `/v1/models` and
  `/v1/chat/completions` without authentication. Servers that require a token,
  use another base path, or omit JSON response format support need a separate
  adapter.
- Remote API adapters use fixed provider endpoints and automatically selected
  or user-selected model IDs.
  Wire responses are tested with fixtures, but live credential, entitlement,
  billing, quota, and model compatibility were not tested here. API mode is
  request based and does not keep provider-side sessions or stream events.
- Embedded local agents can request an allowlisted StreamerAI tool through the
  same dispatcher used by MCP. The current discovery coordinator allows
  `inspect_media` during grounded ranking; other tools remain exposed to
  external MCP hosts and can be enabled for a bounded internal workflow later.
- The MCP stdio bridge implements the small tools/list and tools/call protocol
  surface without an SDK dependency. Validate it with each target host before
  wider distribution, especially if the host requires newer MCP features.
- The Codex and Claude protocol adapters are unit and type checked but were not
  exercised against an authenticated CLI in this environment.
- Local CLI event streams are available through `AgentSession.streamEvents()`;
  the current discovery HTTP response does not relay token deltas to the web UI.
- Playback grants belong to the running server process; a bridge pointed at a
  different instance cannot inspect or revoke them.
