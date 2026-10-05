# StreamerAI developer documentation

This directory describes the implementation in this repository. Product rules
and approved future decisions remain authoritative in [`../instructions`](../instructions/).

## Start here

- [`DEVELOPMENT.md`](DEVELOPMENT.md) - install, run, test and debug the workspace.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) - portable Docker profile, encrypted secrets and host Ollama.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) - boundaries, data flow and invariants.
- [`API.md`](API.md) - currently implemented HTTP endpoints.
- [`TITLE_DETAILS.md`](TITLE_DETAILS.md) - film details, progressive episode discovery, and exact-episode playback.
- [`PLAYER.md`](PLAYER.md) - audio outputs, subtitles, seek timing and series autoplay.
- [`INTEGRATIONS.md`](INTEGRATIONS.md) - how to add metadata, media, subtitle,
  search, agent and sync providers.
- [`VALIDATION.md`](VALIDATION.md) - second-sight findings, verified invariants
  and external release gates.
- [`FIRST_FLIGHT.md`](FIRST_FLIGHT.md) - observed Docker, Ollama and responsive UI
  acceptance results.

## Current milestone

The repository contains a working local vertical slice:

- conversational Home with populated default sections;
- validated-result layout with a best match, playable results and visibly
  unavailable results;
- Library, editable Watch History and playback membership only after a live
  just-in-time media recheck;
- SQLite canonical-title cache and provider ID mappings;
- guided TMDB and Webshare credential verification with sanitized public responses;
- durable conversational sessions and idempotent replay;
- full local Ollama capability preflight and a structured-agent adapter;
- provider-neutral contracts, family registries, TMDB normalization, portable
  encrypted secret storage and a Webshare authentication/media/ticket adapter.

Production now uses `LiveContentCoordinator`: a bounded API/similarity lane
returns provisional validated titles without Ollama while the local agent
explores the same request in parallel. TMDB validates canonical identity,
ratings and explicitly named people; Webshare deterministically verifies
availability and formats. The two lanes merge by canonical title ID. The
preview provider remains a development/test fallback and cannot start
playback. Real Webshare search and format inspection have passed; the final
playback/Range/seek acceptance spike, subtitle retrieval, web search and
Cloudflare sync remain open.

## Specification map

| Topic | Normative specification |
| --- | --- |
| Product behavior and limits | [`../instructions/CONCEPT.md`](../instructions/CONCEPT.md) |
| Conversational discovery pipeline | [`../instructions/DISCOVERY.md`](../instructions/DISCOVERY.md) |
| UI and interaction behavior | [`../instructions/UI.md`](../instructions/UI.md), [`../instructions/DESIGN.md`](../instructions/DESIGN.md) |
| Provider rules | [`../instructions/INTEGRATIONS.md`](../instructions/INTEGRATIONS.md) |
| Local model choice and runtime | [`../instructions/LOCAL_AGENT.md`](../instructions/LOCAL_AGENT.md) |
| Deployment and staged gates | [`../instructions/DEPLOY.md`](../instructions/DEPLOY.md) |

When implementation and specification differ, do not silently change the
product rule. Record the mismatch, add a test for the intended behavior, and
update both documents only after the decision is approved.
