# StreamerAI release notes

Write upcoming changes under **Unreleased**. A commit to `main` whose message
contains `(major)`, `(minor)` or `(patch)` releases them: the section moves under
the new version and is copied into the GitHub release.

## Unreleased

_Nothing yet._

## v1.0.0 (2026-11-21)

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
