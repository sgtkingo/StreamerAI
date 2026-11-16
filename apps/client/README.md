# StreamerAI Client

An installable player for an existing StreamerAI home server. Windows, Linux and macOS use a sandboxed Electron window; Android and Android TV use the system WebView. The native interface only discovers and selects a server. The selected server supplies the existing web application, playback and device pairing, and remains the source of household data.

The client remembers a random client ID, the selected server address and its server ID. Pairing credentials remain in private browser cookies. A different server ID at a saved address requires selecting that server again. Selecting **Forget server and pairing** clears the saved selection and browser pairing. Connecting or disconnecting the household from cloud management does not require reinstalling the client.

## Run and package desktop clients

From the repository root, install dependencies using the repository's pnpm version, then:

```sh
pnpm --filter @streamer-ai/client start
pnpm --filter @streamer-ai/client typecheck
pnpm --filter @streamer-ai/client test
pnpm --filter @streamer-ai/client test:smoke
pnpm --filter @streamer-ai/client package:win
pnpm --filter @streamer-ai/client package:linux
pnpm --filter @streamer-ai/client package:mac
```

Build on the corresponding operating system. Windows produces an NSIS installer, Linux produces AppImage and Debian packages, and macOS produces DMG and ZIP packages under `apps/client/release/`. The Windows installer is named `StreamerAI-Client-<version>-win-x64-setup.exe`; release builds also embed it in the combined StreamerAI setup. These builds have no publisher signing credentials. Distribution outside pilot testing requires Windows signing and macOS signing/notarization configured by the publisher.

The Windows x64 installer has been built and its native Electron security boundary exercised on Windows. Linux and macOS packaging configuration is included; those packages require validation on their native operating systems.

## Build Android and Android TV

The single Android app supports both touch and TV launchers. Android 8.0/API 26 or later and an up-to-date Android System WebView are required. Native controls support the TV D-pad; Back returns from playback/fullscreen or opens server selection, and Menu opens server selection. Physical TV playback and remote-control testing remain necessary before a TV release.

Install JDK 17 and Android SDK Platform 36 with Build Tools 35.0.0, accept the SDK licenses, and set `JAVA_HOME` and `ANDROID_HOME` to those installations. The checked-in Gradle wrapper downloads its pinned Gradle version and verifies its SHA-256 checksum.

```sh
pnpm --filter @streamer-ai/client android:debug
pnpm --filter @streamer-ai/client android:release
```

The debug build runs the Android unit tests and writes `android/app/build/outputs/apk/debug/app-debug.apk` signed with Android's debug key. A release build is signed when `STREAMERAI_ANDROID_KEYSTORE`, `STREAMERAI_ANDROID_KEYSTORE_PASSWORD`, `STREAMERAI_ANDROID_KEY_ALIAS` and `STREAMERAI_ANDROID_KEY_PASSWORD` are set (the release workflow restores them from GitHub secrets). `versionName`/`versionCode` come from this package's `version`. Every later update must be signed with the same release key; a debug-signed pilot APK has to be uninstalled once before installing a release build.

## Updates

Both apps load the interface from the home server, so most changes arrive with server updates. The native shells update themselves from the latest GitHub release (`stable.json`):

- **Windows** checks 30 s after start and every 12 hours, verifies the Ed25519-signed metadata with the keys pinned from `packaging/update-trust.json` at build time, downloads and checks the installer's SHA-256, then offers **Restart now** or installs silently when the app closes.
- **Android** checks once a day (or via **Check for app updates** in server selection), asks before downloading, checks size and SHA-256 and hands the APK to the system installer. Android asks again and accepts only an APK signed with the app's release key. Installing requires allowing _Install unknown apps_ for StreamerAI once. After Google Play distribution starts, Play handles updates instead.

## Discovery and pairing

Discovery uses IPv4 UDP port **47777**, multicast group **239.255.77.77**, plus LAN broadcast. Requests and responses use the versioned protocol in `packages/discovery`. Responses carry a fresh request nonce and expose only the server name, address and public server/household identifiers. The client checks `/api/v1/installation/discovery` at the chosen address before opening it; device approval still happens in the server web application.

The server's advertised URL must be reachable from the client. For Docker, configure `STREAMERAI_ADVERTISE_URL` with the host's LAN address, for example `http://192.168.1.20:8080`. Multicast may be blocked by Docker bridge networking, Windows Docker Desktop, a VPN, router isolation or a firewall even when UDP is published. Use the server address or a connection QR link when discovery is unavailable. Native Linux host networking is another deployment option. `localhost` on a TV or phone refers to that device, not the home server.

Connection links have the form `streamerai://connect?url=<encoded-server-origin>&serverId=<server-id>`. Android camera apps can open these links; a URL or link can also be pasted into the chooser. No QR-scanning permission is required by this app.

Local HTTP is supported for loopback, private LAN addresses and local hostnames; use HTTPS outside the LAN. For a locally issued HTTPS certificate, install its CA certificate in the operating system's trust store. The app keeps certificate verification enabled. Remote pages have no Node.js access or native JavaScript bridge, cannot navigate the native chooser, and open external HTTPS links in the system browser.
