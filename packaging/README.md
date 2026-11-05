# Distribution prototype

This implements P0 runtime packaging and an offline verification/staging part of
P2. It does not publish releases, install services on the development machine,
enable LAN access, or automatically activate an update. The distribution target
is `sgtkingo/StreamerAI`.

## Build a portable runtime

Use Node 24 LTS, at least 24.7, and the repository's pinned pnpm. Install frozen
dependencies and build the web client first:

```sh
pnpm install --frozen-lockfile
pnpm --filter @streamer-ai/web build
pnpm distribution:test
pnpm distribution:bundle --runtime-only --archive
```

An explicitly prepared web build can be selected with `--web-directory PATH`.
For example, a local review build can live in `dist/deploy-review-web` while CI
uses the default `apps/web/dist`. This changes the source of copied static assets
only; the bundle inventory and runtime smoke checks still apply.

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

For a full component bundle, supply **previously verified** target binaries:

```sh
pnpm distribution:bundle --node /trusted/node --ffmpeg /trusted/ffmpeg \
  --ffprobe /trusted/ffprobe --gateway /trusted/caddy \
  --notices /trusted/notices --archive
```

On Windows also supply `--service-wrapper C:/trusted/WinSW.exe`. The notices
directory must contain `NODE.txt`, `FFMPEG.txt`, `CADDY.txt`, and on Windows
`WINSW.txt`, covering the actual binary builds. Dependency package licenses are
copied with packages; `app/DEPENDENCIES.json` records versions and license fields.
The build never downloads third-party binaries. A full component bundle still
has `releaseReady: false` until signing and acceptance gates are complete.

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
Ollama and models are optional external components and are not downloaded.

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
