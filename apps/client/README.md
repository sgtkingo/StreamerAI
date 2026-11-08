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

Build on the corresponding operating system. Windows produces an NSIS installer, Linux produces AppImage and Debian packages, and macOS produces DMG and ZIP packages under `apps/client/release/`. These pilot builds have no publisher signing credentials. Distribution outside pilot testing requires Windows signing and macOS signing/notarization configured by the publisher.

The Windows x64 installer has been built and its native Electron security boundary exercised on Windows. Linux and macOS packaging configuration is included; those packages require validation on their native operating systems.

## Build Android and Android TV

The single Android app supports both touch and TV launchers. Android 8.0/API 26 or later and an up-to-date Android System WebView are required. Native controls support the TV D-pad; Back returns from playback/fullscreen or opens server selection, and Menu opens server selection. Physical TV playback and remote-control testing remain necessary before a TV release.

Install JDK 17 and Android SDK Platform 36 with Build Tools 35.0.0, accept the SDK licenses, and set `JAVA_HOME` and `ANDROID_HOME` to those installations. The checked-in Gradle wrapper downloads its pinned Gradle version and verifies its SHA-256 checksum.

```sh
pnpm --filter @streamer-ai/client android:debug
pnpm --filter @streamer-ai/client android:release
```

The debug build runs the Android unit tests and writes `android/app/build/outputs/apk/debug/app-debug.apk`. It is an installable pilot APK using Android's debug signing key. Release output is unsigned until publisher signing is configured. The completed pilot artifacts are preserved as `release/StreamerAI Client Setup 0.1.0.exe` and `release/StreamerAIClient-0.1.0-debug.apk`.

## Discovery and pairing

Discovery uses IPv4 UDP port **47777**, multicast group **239.255.77.77**, plus LAN broadcast. Requests and responses use the versioned protocol in `packages/discovery`. Responses carry a fresh request nonce and expose only the server name, address and public server/household identifiers. The client checks `/api/v1/installation/discovery` at the chosen address before opening it; device approval still happens in the server web application.

The server's advertised URL must be reachable from the client. For Docker, configure `STREAMERAI_ADVERTISE_URL` with the host's LAN address, for example `http://192.168.1.20:8080`. Multicast may be blocked by Docker bridge networking, Windows Docker Desktop, a VPN, router isolation or a firewall even when UDP is published. Use the server address or a connection QR link when discovery is unavailable. Native Linux host networking is another deployment option. `localhost` on a TV or phone refers to that device, not the home server.

Connection links have the form `streamerai://connect?url=<encoded-server-origin>&serverId=<server-id>`. Android camera apps can open these links; a URL or link can also be pasted into the chooser. No QR-scanning permission is required by this app.

Local HTTP is supported for loopback, private LAN addresses and local hostnames; use HTTPS outside the LAN. For a locally issued HTTPS certificate, install its CA certificate in the operating system's trust store. The app keeps certificate verification enabled. Remote pages have no Node.js access or native JavaScript bridge, cannot navigate the native chooser, and open external HTTPS links in the system browser.
