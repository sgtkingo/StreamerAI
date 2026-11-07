# Linux server application installer

The normal user installs a `.deb` through the desktop package installer. It
contains the Node runtime, compiled StreamerAI server and web client, FFmpeg and
Caddy. Desktop package dependencies supply Python/GTK, PolicyKit, certificate
tools and standard system libraries automatically. Clients use a web browser;
there is no separate desktop client to install.

The package registers two restricted `streamerai` systemd services and creates
**StreamerAI** and **StreamerAI Local AI Setup** entries in the applications menu.
Opening either shows the normal-user setup window. It detects an existing Ollama
API, installation and `qwen3.5:4b`; existing installations/models are reused.
The user can explicitly select runtime installation/start and a model download,
or continue without AI. GPU drivers are never installed automatically.
The GTK window uses the red `STREAMER` and white `AI` brand, a dark high-contrast
theme and the packaged StreamerAI application icon. Completing or failing an
operation opens a separate result page with a plain-language summary, `STATUS`,
machine-readable `CODE`, detail and an Open or Retry action. Progress messages
remain on the setup page while work is running.

The local privileged helper is root-owned and only accepts fixed operations.
It can inspect the instance CA, trust that exact certificate after fingerprint
confirmation, read the one-time bootstrap key, or prepare/start the selected local
Ollama runtime. No path, download URL, command or model name is accepted from the
GUI. Authorization uses the normal PolicyKit desktop dialog. The browser is
always launched as the desktop user. Its one-time setup key is passed in a URL
fragment consumed by the web client, never in an HTTP query or application log.

System CA trust and supported per-user NSS certificate stores are prepared
automatically. Running/password-protected/browser-specific stores can need a
browser restart or explicit trust approval; real supported-browser acceptance
must verify this before a stable release. CA private keys remain on the server.

An optional new Ollama install uses the bundled pinned descriptor, an official
HTTPS asset and exact byte-length/SHA-256 checking. It downloads about 1.5 GB
only after selection. The helper rejects an existing installation instead of
overwriting it, extracts into protected staging with Python's tar data filter,
then creates a dedicated restricted service. The recommended model is downloaded
through the local API only when absent. Model storage and prior installations
are retained. No remote install script is piped to a shell.

The initial `.deb` deliberately refuses in-place upgrades rather than silently
replacing an existing runtime. Removal stops the server/gateway and preserves
profiles, vault, keys, CA and optional Ollama/model data. A later supervised update
path must coordinate backup, migration and rollback.

Build on a Linux x64 host from a **complete verified Linux bundle**:

```sh
node scripts/distribution/setup-linux.mjs \
  --bundle dist/distribution/streamerai-server-0.1.0-linux-x64 \
  --output dist/setup/linux-x64
```

`dpkg-deb --build --root-owner-group` creates
`streamerai-server_<version>_amd64.deb`. On another build host, `--dry-run`
prepares and verifies the package tree without executing Linux programs,
installing services or making network requests. The builder API is
`buildLinuxSetup({ bundle, output, dryRun })`.

The first declared target is Ubuntu 24.04+ and Debian 13 desktops with Python
3.12+ and systemd. Windows tests cover package-tree content, payload refusal and
Python syntax/pure self-tests; they do not establish Linux installation, GPU,
reboot, browser or removal acceptance. Public release also needs signing,
component source/license review and the deploy plan's release gates.
