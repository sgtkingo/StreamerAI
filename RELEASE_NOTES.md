# StreamerAI release notes

Write upcoming changes under **Unreleased**. A commit to `main` whose subject
(first line) contains `(major)`, `(minor)` or `(patch)` releases them: the
section moves under the new version and is copied into the GitHub release.

## Unreleased

_Nothing yet._

## v0.14.0 (2026-11-22)

### Improved

- **Cloud connection:** connect an existing local household to cloud management
  from administration without manually configuring the cloud service address.
  Pairing preserves the household, profiles and Master PIN.
- The profile chooser now links directly to household administration.

## v0.13.1 (2026-11-22)

### Improved

- **Real file details from Webshare:** resolution, video codec, length and
  every audio track (language, codec, channels) now come from what Webshare
  measured on the file instead of being guessed from its name. A widescreen
  1920×816 release counts as 1080p, and a Czech dub is found even when the
  name does not mention it.
- Source choice for titles and episodes ranks by these real audio languages and
  resolutions, so the preferred dub wins more reliably.
- **Fast search** fills the Video and Audio columns with the measured values
  (marked with a check) shortly after results appear, shows each file's length
  and marks files Webshare no longer serves as unavailable. Hover a cell for
  the exact picture size, bitrate and audio tracks.

## v0.13.0 (2026-11-21)

### New

- **Fast search:** a new page next to Download searches file names directly in
  Webshare, Hellspy and local folders, without AI or catalog matching. Results
  arrive per source, sorted by best match or in each source's own order, with
  filters for source, name, format, video, audio and size. Play a file straight
  away or save a Webshare file into the _Fast Search_ folder; playback resumes
  where you stopped but stays out of Library and history.

## v0.12.0 (2026-11-21)

### New

- **Uninstall:** StreamerAI Server appears in Settings → Apps and can be removed
  there. Household data is kept unless you choose to delete it, and the app for
  this PC can be removed in the same step. The local HTTPS certificate,
  services, shortcuts and program files are cleaned up.

### Fixed

- Automatic updates rolled back every new version: the updater's health check
  could not read the server version without a session. A rollback now also
  starts the services again even when one restore step fails.
- The pre-update database backup is taken after the services stop, and SQLite's
  temporary shared-memory file is no longer copied (restoring it could fail).

### Changed

- The bundled FFmpeg is the gyan.dev 8.1.2 release build (smaller download;
  the previous build was withdrawn by its publisher).

## v0.11.0 (2026-11-21)

### New

- **One Windows setup:** install the server, the StreamerAI app for this PC, or
  both. The app installs without administrator rights and opens a server on the
  same PC automatically.
- **In-place upgrades:** running a newer setup over an existing server keeps the
  household, profiles, keys and HTTPS certificate. If the new version does not
  start, the previous version is restored. Older setups never downgrade a server.
- **Automatic server updates:** the server checks for signed releases every six
  hours, downloads and verifies them in the background and reminds the owner in
  administration and in the player. _Install now_, _Remind me tomorrow_, or
  enable nightly installation (02:00–05:00, only when nobody is watching) in
  Administration → Updates.
- **Safe installation:** the new `StreamerAIUpdater` service re-verifies the
  release, installs it beside the running version, backs up the database and
  rolls back services and data automatically when the update fails.
- **Self-updating apps:** the Windows app downloads verified updates and installs
  them on restart; the Android/TV app offers updates daily and installs them
  through the system installer (release-signed APKs only).
- **Release pipeline:** releases are published automatically from `main` with
  Ed25519-signed update metadata, which is re-signed weekly.
- **Household setup:** after creating a household, the owner is guided through
  the household name, shared services, the AI agent, backups and device pairing
  in administration. _Finish later_ is always available, and the setup can be
  run again from Administration → Household.

### Changed

- One version for the server, web app, Windows app and Android app.
- The AI agent is shared by the whole household like other services; an agent
  configured earlier for one profile now applies to every profile.
- Clearer first-run screens for creating a household and importing a backup.
- The Android app shows its version and has a _Check for app updates_ button.
- The "Configure local AI" shortcut and agent connector follow the active
  release after updates.

### Known limitations

- Windows installers are not Authenticode-signed yet (SmartScreen warns).
- Automatic updates cover Windows servers; Linux and Docker servers are updated
  manually.
- The pilot debug APK must be uninstalled once before installing a release APK.

### In progress

- Community source database (shared verified sources across households); only
  per-profile thumbs exist so far.
- Priority and spot availability rechecks, caching improvements and tile hover
  previews.
- Signed Windows installers, clean-machine upgrade/rollback acceptance, Linux
  updates and Google Play distribution.

## v0.10.0 (2026-11-15)

Versions up to 0.10.0 were assigned retroactively from the commit history; they
were not published as releases.

- Household model: one home server per household with up to five profiles and an
  8-digit Master PIN that never leaves the server.
- Local six-digit and QR pairing, a separate `/admin` household console and thin
  clients for Windows and Android/TV with LAN discovery.
- Encrypted hourly local backups and optional cloud household management.
- MCP server and agent connector for Claude Code, Codex, Claude Desktop and Cursor.
- Improved log security, pairing, profiles, settings and admin UI.

## v0.9.0 (2026-11-07)

- First pilot deployment: Windows server setup with services, local HTTPS and
  optional Ollama/model installation; Linux `.deb` builder.

## v0.8.0 (2026-11-04)

- Cloud sync and account management with Google sign-in.
- Thumbnail system, AI-assisted source choice and profile PINs.

## v0.7.0 (2026-10-26)

- Hellspy source and optional source priorities.
- Better scoring and recommendations, in-page help in Settings and a smarter
  content coordinator.

## v0.6.0 (2026-10-22)

- Seasonal animated themes: rain and storm, autumn wind and leaves, spring,
  summer, winter and day/night.

## v0.5.0 (2026-10-20)

- Smarter agent with context tokens, fast replies and intelligent composing.
- Agent selection with API and MCP options, improved onboarding, preferred source
  selection and better error descriptions.

## v0.4.0 (2026-10-11)

- Integration architecture, local files and offline downloads including mass
  download; separate channels per user.

## v0.3.0 (2026-10-10)

- Multi-source and two-way search, series search and a reworked player with
  subtitles and audio tracks.

## v0.2.0 (2026-10-02)

- Users and settings, series support, logs and player and UI fixes.

## v0.1.0 (2026-09-29)

- Architecture and the first working conversational search with Webshare.
