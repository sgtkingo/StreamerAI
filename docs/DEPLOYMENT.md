# Docker deployment

The primary self-hosted profile is portable Docker Compose. Ollama remains
host-native for straightforward GPU access; StreamerAI does not expose Ollama
to the browser or publish its port.

## First start

1. Install Docker Desktop (Windows/macOS) or Docker Engine with Compose (Linux).
2. Install and start Ollama on the host and keep `qwen3.5:4b` available.
3. Create the installation key: `node scripts/generate-master-key.mjs`.
4. Run `docker compose up --build`.
5. Open `http://localhost:8080` and complete the guided setup.

The web container is the only published service. It serves the PWA and proxies
same-origin `/api` calls to the private server container. The server reaches
Ollama using `host.docker.internal`; Compose supplies the Linux `host-gateway`
mapping as well.
The published web port is bound to host loopback. For local CLI agents and the
MCP stdio bridge, see [Agent and MCP integration](AGENT_INTEGRATION.md).

## Secret and data lifecycle

- SQLite and `secrets.vault` live in the `streamerai_data` Docker volume.
- `.secrets/streamerai_master_key` is mounted read-only and is ignored by Git.
- On Windows, Docker Desktop can display bind-mounted files with synthetic
  Linux mode bits (commonly `0777`). Treat the host Windows ACL as authoritative
  and restrict the `.secrets` directory to the installation account and system
  administrators.
- Vault values use AES-256-GCM with a fresh nonce and authenticated envelope on
  every mutation; writes replace the vault atomically.
- Back up the volume and master key separately. Neither backup alone reveals a
  credential. Losing the key requires reconnecting integrations.
- Never paste TMDB, Webshare or future provider credentials into `.env`, Compose
  YAML, logs or issue reports. They are entered through the local setup UI.

The `SecretStore` boundary remains provider-neutral. A future Kubernetes,
Vault, Bitwarden or cloud-secret adapter can replace the encrypted file store
without changing TMDB, Webshare or other integration clients.

## Ollama troubleshooting

From the host, `http://127.0.0.1:11434/api/version` must respond. From the
server container, `http://host.docker.internal:11434/api/version` must respond.
If Ollama is bound only to host loopback and Docker cannot reach it, configure
Ollama to listen on the host/container bridge and restrict that listener with
the host firewall. Do not expose port 11434 to the LAN or internet.

The in-app preflight verifies the Ollama version, exact configured tag,
Q4_K_M metadata, license, structured JSON, tool calling and post-warmup model
residency. A reachable endpoint alone is not considered ready.
