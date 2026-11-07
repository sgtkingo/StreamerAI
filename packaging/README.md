# Server installation and distribution

The distributed product is a **server setup application** that prepares its
runtime, services, protected storage and local HTTPS. It detects existing Ollama
installations and local models, reuses them, and offers missing AI installation
or model download after explicit user selection. Clients use an ordinary web
browser and do not install Node, FFmpeg, Ollama or a separate desktop client.

Windows has a .NET WinForms setup executable with local AI configuration and
browser onboarding. Linux has a `.deb` builder and desktop setup/helper sources
for Debian/Ubuntu. See the [Windows setup application](setup/README.md) and
[Linux installer](setup/linux/README.md) for user flow, build commands and limits.
The runtime archives and service scripts below are developer/build inputs.

The current installers are **unsigned previews for controlled acceptance**.
Complete bundled components do not establish clean-machine, reboot, upgrade,
GPU or browser acceptance, and the Windows development host does not establish
Linux installation support. Builds and tests do not install services on the
development machine, publish releases, enable LAN access or automatically
activate server updates. The distribution target is `sgtkingo/StreamerAI`.

## Installer candidates and build inputs

The manual [server installer workflow](../.github/workflows/server-installers.yml)
uses Node **24.22.2 LTS** on Windows/Linux x64, installs locked dependencies,
checks the workspace, prepares pinned components, and creates `.exe` or `.deb`
candidate artifacts. Final local installer artifacts and their hash/build
records belong in `dist/installers`; intermediate bundles, compiler files and
download caches may be removed after the finished installer is verified.

Build components are prepared by the release builder, not located by the end
user. [Component preparation](COMPONENTS.md) uses committed per-platform locks,
immutable upstream release URLs, exact byte lengths/SHA-256 and explicit archive
members. On the target build host:

```sh
node scripts/distribution/components.mjs --output dist/installer-components
```

The resulting `bin/` and `notices/` directories supply the complete server bundle
for the platform-specific setup builder. They include the real FFmpeg/Caddy and
Windows service-wrapper files, along with matching component notices. A fresh
output directory is required; cached downloads are verified before reuse.

Use native dependencies built for the exact target Node ABI. A Node25 development
binding cannot be copied into the Node24 server. For reproducible Windows
Node24.22.2 and better-sqlite3 ABI137 inputs, use the committed runtime lock and
[runtime preparation helper](NODE_RUNTIME.md):

```sh
node scripts/distribution/node-runtime.mjs --output dist/runtime-inputs/win-x64-node24
```

The helper prepares the verified Node executable, matching SQLite binding,
license and provenance record without changing the host installation. When
building from another supported development Node version, supply both
`--node <prepared-node.exe>` and `--sqlite-binding <prepared-better_sqlite3.node>`
to the bundler; its target-runtime SQLite smoke test must still pass. All notices
must match the actual distributed versions. `releaseReady` stays false until
signing, source/license review and the acceptance gates are complete.

## Developer runtime archives

Use Node **24.22.2 LTS** and the repository's pinned pnpm for a release build.
Install frozen dependencies and build the web client first:

```sh
pnpm install --frozen-lockfile
pnpm --filter @streamer-ai/web build
pnpm distribution:test
pnpm distribution:bundle --runtime-only --archive
```

An explicitly prepared web build can be selected with `--web-directory PATH`.
CI uses the default `apps/web/dist`. A separate local review build can be selected
without replacing it. This changes the source of copied static assets only; the
bundle inventory and runtime smoke checks still apply.

The output in `dist/distribution` is an explicitly incomplete runtime prototype.
It includes the current Node executable, compiled JavaScript server, compiled
workspace packages, production dependencies with native SQLite bindings, and the
web client. It contains no TypeScript loader or pnpm runtime requirement. The
builder copies exact installed dependencies; frozen installation and typechecking
are mandatory release inputs. Transpilation alone does not typecheck source.

Build on the target Windows/Linux x64 OS with the target Node version. Native
SQLite modules must match that Node ABI. Do not copy modules between platforms.
Linux binaries also require compatible glibc and shared libraries. Ubuntu 24.04
and Windows Server 2022 CI runners are build/test environments, not a claim of
Windows 11 or Debian clean-machine acceptance.

For a full component bundle, pass the prepared target components to the bundler:

```sh
pnpm distribution:bundle --output dist/installer-build/server-bundle \
  --ffmpeg dist/installer-components/bin/ffmpeg \
  --ffprobe dist/installer-components/bin/ffprobe \
  --gateway dist/installer-components/bin/caddy \
  --notices dist/installer-components/notices
```

On Windows use the `.exe` component names and add
`--service-wrapper dist/installer-components/bin/streamerai-service.exe`.
The notices directory must contain `NODE.txt`, `FFMPEG.txt`, `CADDY.txt`, and
on Windows `WINSW.txt`, covering the actual builds. Dependency package licenses
are copied with packages; `app/DEPENDENCIES.json` records their versions and
license fields. The bundle step consumes verified prepared files; downloading
third-party components belongs to the separate preparation step above.
Pass the complete bundle to `setup-windows.mjs` or `setup-linux.mjs` as documented
in their linked setup guides. A full component bundle still has
`releaseReady: false` until signing and acceptance gates are complete.

`bundle.json` records all distributed file sizes and hashes. This is corruption
detection, **not** authenticity: use independently verified signed release
metadata for authenticity. Native service installer scripts default to a dry run
and refuse incomplete bundles. Controlled prototype service testing requires
`install-linux.sh --apply --allow-prototype` or
`install-windows.ps1 -Apply -AllowPrototype` with OS administrator privileges.
Do not use these scripts for in-place upgrades.

## Layout and local services

Runtime releases are immutable and separate from writable state. Linux uses
`/opt/streamerai/releases/<version>`, a `current` link, and `/var/lib/streamerai`.
Windows uses `%ProgramFiles%/StreamerAI/releases/<version>` and
`%ProgramData%/StreamerAI`. State has `data/`, `keys/master.key`, `gateway/`, and
on Windows `logs/`. Service removal preserves state. A key is created only when
missing. Protect it separately from shared backups.

Linux services run as the restricted `streamerai` user; Windows wrappers use
LocalService. The API binds loopback. The bundled Caddy template serves the web
and API at `https://localhost:8443` with an instance-local CA. CA trust must be
configured on clients before production use. The template does not open a LAN
listener or firewall port. Windows service setup depends on a compatible WinSW
binary; actual WinSW and systemd installation/reboot trials remain gates.
New native installs default to local owner/device pairing. An explicit access
mode in restored `runtime.env` is retained. Existing Docker/local development
defaults remain unchanged; enable pairing explicitly there before LAN use.

For runtime inspection without services, initialize an isolated state directory
and a base64-encoded 32-byte key at `keys/master.key`, then run:

```sh
STREAMERAI_STATE_ROOT=/absolute/state ./runtime/node ./service/start.mjs
```

This starts only the API. A browser needs the gateway for the bundled web client.
The normal setup application prepares both services and opens browser onboarding;
the inspection command does not perform the installer's optional AI setup.
Ollama and models are detected and downloaded only through explicit setup choices.

The offline backup CLI is bundled at `backup.mjs`. For example, set
`STREAMERAI_STATE_ROOT` to the state directory and run
`./runtime/node ./backup.mjs export --output /offline/server.streamerai-backup`.
Use `./runtime/node ./backup.mjs --help` for inspect/restore/recovery commands.
The CLI prompts for a passphrase without putting it in process arguments. Stop
the server before restore; see `docs/OFFLINE_BACKUP.md` in the source repository.

## Signed release verification prototype

The staging CLI supports offline files and uses Node's Ed25519 verifier. It
verifies distinct trusted signing keys against a local signature threshold,
metadata and trust expiration, key epoch, platform, channel, version, artifact
URL origin, byte length, SHA-256, and a persisted sequence/high-water mark. It
never extracts or executes the downloaded artifact. It does not rely on a hash
file beside a download. `--commit` acquires a local lock, copies the verified
archive into staging, verifies the copy, and persists replay protection.

```sh
pnpm distribution:verify --root /protected/update-trust.json \
  --metadata /downloads/stable.json --artifact /downloads/server.zip \
  --state /protected/update-state.json --staging /protected/staging \
  --current-version 0.1.0 --platform win-x64 --channel stable
```

Without `--commit` this is read-only. On Linux use `--platform linux-x64`.
`packaging/update-trust.example.json` intentionally has no trusted keys and an
expired validity: it cannot authorize a release. Supply independent public keys,
a future validity period, and a threshold through a trusted installation step.
Private keys never belong in the runtime, repository, or untrusted PR jobs.

An offline release operator can create a signed envelope for complete archives:

```sh
pnpm distribution:sign --version 0.2.0 --sequence 1 --channel beta \
  --expires <ISO-date-within-31-days> \
  --base-url https://github.com/sgtkingo/StreamerAI/releases/download/v0.2.0/ \
  --key release-1=/offline/key-1.pem --key release-2=/offline/key-2.pem \
  --output beta.json streamerai-server-0.2.0-win-x64.zip \
  streamerai-server-0.2.0-linux-x64.tar.gz
```

The envelope signs exact UTF-8 payload bytes encoded in base64. This small
prototype is **not a TUF implementation**. It has no delegated roles, automatic
root rotation, online polling/downloading, freeze detection beyond expiration,
quiescing, snapshots, migration rehearsal, activation, or rollback supervisor.
Use a maintained TUF client before enabling unattended production activation;
evaluate its trust migration rather than claiming this prototype supplies TUF.
For equal numeric beta versions the verifier conservatively refuses transitions
between different prerelease labels; increment the numeric version for now.

The candidate workflow creates reviewable artifacts only. Production publication
still requires verified third-party binary provenance and notices, Authenticode
for Windows installers, trusted root provisioning/rotation, all P2 activation and
backup/rollback steps, clean-machine installation/reboot/upgrade tests, and the
LAN HTTPS acceptance test from `docs/DEPLOY_PLAN.md`.
