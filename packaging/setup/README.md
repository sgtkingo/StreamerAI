# Server installation application

The distributed product is the **server installation application**; clients use
an ordinary browser. Windows setup is a .NET Framework WinForms executable.
It carries a verified server ZIP, so the user supplies no Node, pnpm, FFmpeg,
Caddy or WinSW files. Those complete, pinned components are supplied by the
release build, not by the end user.

The installer opens without elevation. Clicking Install requests Windows UAC
for server services, protected program/state directories, local HTTPS trust and
Start menu entries. The normal user process remains in control of optional
Ollama installation and model download, even if different administrator
credentials are used for the server step. No installer is run during the build
or tests, and no user data is changed by `--self-test` or `--preview-image`.

## Build

```sh
node scripts/distribution/setup-windows.mjs \
  --bundle dist/installer-build/win-bundle \
  --output dist/installer-build/windows-setup \
  --ollama-descriptor packaging/setup/ollama-windows.pinned.json
```

Build this on Windows with its .NET Framework compiler. The input must be a
complete Windows bundle matching `bundle.json`. The builder verifies every
listed input and embeds the ZIP's digest and byte length. `--review` is available
for incomplete test fixtures; it permanently disables installation in that
executable. Full components with `releaseReady: false` produce a clearly marked
Preview installer whose installation action remains available for controlled
acceptance. Authenticode signing and clean-machine acceptance remain release
requirements; the inventory/digest is not a substitute for a publisher signature.

The setup checks its own embedded payload in `--self-test`. A GUI preview can be
rendered to a PNG without showing the form, probing services or downloading:

```sh
StreamerAI-Server-0.1.0-win-x64-setup.exe --preview-image wizard.png
StreamerAI-Server-0.1.0-win-x64-setup.exe --preview-image success.png --preview-state success
StreamerAI-Server-0.1.0-win-x64-setup.exe --preview-image error.png --preview-state error
StreamerAI-Server-0.1.0-win-x64-setup.exe --preview-image options.png --preview-state options
```

The builder creates a multiresolution Windows icon matching the web app's red
`S` and white `AI` mark and embeds it in the EXE. The wizard uses the web app's
red `STREAMER` and white `AI` wordmark. Installed AI components appear as
readable completion labels instead of disabled dark checkboxes. After setup, a
dedicated result screen shows a human summary, `STATUS`, a stable error/result
`CODE`, technical detail and the appropriate retry or browser action. The
successful flow waits for the user to choose **Open StreamerAI**.

## User flow

1. Setup detects the local Ollama API and installed models. It also checks
   standard install locations and the current user's local PATH before offering
   a new runtime. Existing installations and models are preserved.
2. The user explicitly chooses whether to prepare missing Ollama and/or download
   the recommended `qwen3.5:4b` model. Both remain optional. The wizard checks the
   relevant installation, temporary-download and model-storage disk volumes.
3. The server step installs services and protected state, trusts only this
   installation's public Caddy CA on the local machine and checks HTTPS readiness
   with that exact CA in the certificate chain. It does not disable certificate
   verification globally or expose a LAN listener automatically. Services are
   verified as LocalService before their first start.
4. The one-time owner key returns only through a per-run named pipe restricted
   to the original user and local administrators. The browser receives it in
   `/#setup=...`; the application immediately clears the fragment and submits the
   claim. The key is not printed, passed to the elevated child in command
   arguments or copied to browser storage. Opening the browser uses a temporary
   setup URL; the client removes its fragment before submitting the claim.
   A retained installation that already has an owner, or explicitly uses the
   legacy access mode, opens the ordinary URL without generating a new owner key.
   This decision uses bounded installation-status JSON over the same trusted CA.
5. If requested, the normal user process downloads the pinned official Ollama
   installer, enforces its maximum byte length and SHA-256 and verifies Windows
   Authenticode publisher status before running it. The pinned descriptor was
   checked against the official GitHub release asset digest. It is a large
   optional download (currently about 1.7 GB), not bundled into server setup.
6. The model step reuses an existing exact model, otherwise pulls the fixed
   recommended tag through loopback and shows progress. It checks final model
   availability before reporting success. A failed/cancelled AI step leaves the
   installed server usable and can be retried from **Configure local AI** in the
   Start menu (`setup.exe --configure-ai`).

Binary download redirects are restricted to official GitHub asset hosts. Reads,
sizes and time are bounded. Skip AI cancels network/model transfer; it is
temporarily disabled while the official runtime installer is changing files.

The first-install service script rolls back only services and program files
created by that attempt and always preserves ProgramData state, keys and models.
A cleanup failure leaves an explicit `installation-failure.json` repair record.
If services completed but later HTTPS/shortcut/handoff failed, the setup receipt
allows retrying those steps without reinstalling services or replacing data.
The first Windows preview could leave `StreamerAIGateway` stopped because Caddy
could not parse the unquoted `Program Files` path. The corrected setup detects
that exact old Caddyfile by SHA-256 on receipt resume, writes a verified repair
configuration under protected ProgramData, updates only the gateway service
definition, and starts that service. It leaves the installed release inventory
and existing server data intact. Run the new setup executable and choose Retry;
the old executable cannot perform this repair.
Previously existing ProgramData state is adopted only when its owner and access
rules belong to Administrators, SYSTEM or LocalService; reparse points and
untrusted pre-created state are refused. Fresh state is created without silently
adopting an untrusted intervening directory. New managed state and program files
are created with explicit protected ACLs and Administrators ownership; default
CREATOR OWNER rules cannot grant a filtered administrator token write access.
Program files retain Users/LocalService read and execute access. Existing private
data is checked without recursively changing ownership of user data. Receipt
resume checks the same private ownership, access rules and reparse ancestors
before reading its receipt, CA or bootstrap key. A read-only diagnostic is
available as `setup.exe --check-managed-state PATH`.

The bundled WinSW **2.12.0** uses separate service-account fields:
`<serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>`.
Its [version-pinned XML documentation](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md#localservice-account)
specifies this form. The [2.12.0 parser](https://github.com/winsw/winsw/blob/v2.12.0/src/WinSW.Core/Configuration/XmlServiceConfig.cs)
reads `user`; `<username>` is ignored. Its
[account-name builder](https://github.com/winsw/winsw/blob/v2.12.0/src/WinSW.Core/Configuration/ServiceAccount.cs)
prefixes the domain, so a fully qualified account must not be placed in `user`.
The service installer also checks the registered account SID before starting it.

Windows Ollama runs under the installing user's account. Existing model paths
and `OLLAMA_MODELS` are retained. An always-on server with no signed-in desktop
may need a separately managed inference service; the installer does not silently
convert a user's existing Ollama into a service or migrate their models.

Official behavior references:
[Ollama Windows installation](https://docs.ollama.com/windows),
[official Windows installer source](https://github.com/ollama/ollama/blob/main/app/ollama.iss).
