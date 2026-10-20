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
