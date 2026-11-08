import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  discoverServers,
  verifyDiscoveredServer,
} from "@streamer-ai/discovery";
import {
  isSafeExternalUrl,
  isServerNavigation,
  isTrustedShellFrame,
  parseConnectionInput,
  REMOTE_WEB_PREFERENCES,
} from "./security.js";
import { loadClientState, saveClientState } from "./settings.js";
import type { ClientState } from "./types.js";

const directory = __dirname;
const shellUrl = pathToFileURL(join(directory, "renderer.html")).href;
const smokeUrl = !app.isPackaged
  ? process.env.STREAMERAI_CLIENT_SMOKE_URL
  : undefined;
if (smokeUrl && process.env.STREAMERAI_CLIENT_SMOKE_STATE)
  app.setPath("userData", process.env.STREAMERAI_CLIENT_SMOKE_STATE);
let chooser: BrowserWindow | null = null,
  remote: BrowserWindow | null = null;
let state: ClientState;
let settingsFile = "";
let pendingLink = process.argv.find((value) =>
  value.startsWith("streamerai://"),
);
let scanning: ReturnType<typeof discoverServers> | null = null;
let connecting: Promise<void> | null = null;
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (_event, argv) => {
  const value = argv.find((item) => item.startsWith("streamerai://"));
  if (value) void connect(value).catch(showError);
  else showChooser();
});
app.on("open-url", (event, value) => {
  event.preventDefault();
  if (!state) pendingLink = value;
  else void connect(value).catch(showError);
});

function showError(error: unknown) {
  if (smokeUrl) {
    console.error(error);
    app.exit(1);
    return;
  }
  void dialog.showMessageBox({
    type: "error",
    title: "StreamerAI connection",
    message:
      error instanceof Error
        ? error.message
        : "The home server could not be opened.",
  });
  showChooser();
}
function showChooser() {
  if (!chooser || chooser.isDestroyed()) {
    chooser = new BrowserWindow({
      width: 880,
      height: 700,
      minWidth: 420,
      minHeight: 520,
      backgroundColor: "#101011",
      title: "StreamerAI — Choose home server",
      icon: join(directory, "icon.png"),
      show: !smokeUrl,
      webPreferences: {
        ...REMOTE_WEB_PREFERENCES,
        partition: "client-shell",
        preload: join(directory, "preload.cjs"),
      },
    });
    chooser.webContents.on("will-navigate", (event, target) => {
      if (target !== shellUrl) event.preventDefault();
    });
    chooser.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void chooser.loadURL(shellUrl);
  }
  if (!smokeUrl) chooser.show();
  chooser.focus();
}
function trusted(event: IpcMainInvokeEvent) {
  if (
    !chooser ||
    event.sender !== chooser.webContents ||
    !isTrustedShellFrame(event.senderFrame, shellUrl)
  )
    throw new Error("This operation is only available in server selection.");
}
function connect(input: string, expected?: string): Promise<void> {
  if (connecting) return connecting;
  connecting = openServer(input, expected).finally(() => {
    connecting = null;
  });
  return connecting;
}
async function openServer(input: string, expected?: string) {
  const parsed = parseConnectionInput(input);
  const announcement = await verifyDiscoveredServer(parsed.url, {
    expectedServerId: expected ?? parsed.expectedServerId,
    fetch: net.fetch as typeof fetch,
  });
  state = { ...state, selected: announcement };
  await saveClientState(settingsFile, state);
  const prior = remote;
  remote = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#000000",
    title: announcement.name,
    icon: join(directory, "icon.png"),
    show: false,
    webPreferences: {
      ...REMOTE_WEB_PREFERENCES,
      partition: "persist:streamerai-server",
    },
  });
  const current = remote;
  current.webContents.on("will-navigate", (event, target) => {
    if (!isServerNavigation(target, announcement.url)) {
      event.preventDefault();
      if (isSafeExternalUrl(target)) void shell.openExternal(target);
    }
  });
  current.webContents.on("will-redirect", (event, target) => {
    if (!isServerNavigation(target, announcement.url)) event.preventDefault();
  });
  current.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  current.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  current.once("ready-to-show", () => {
    if (!smokeUrl) current.show();
    chooser?.hide();
    prior?.destroy();
  });
  current.on("closed", () => {
    if (remote === current) {
      remote = null;
      if (!chooser?.isDestroyed()) chooser?.show();
    }
  });
  current.webContents.on("did-fail-load", (_event, code) => {
    if (code !== -3)
      showError(
        new Error(
          "The home server is unavailable. Check its address, certificate and network connection.",
        ),
      );
  });
  await current.loadURL(announcement.url);
}

app
  .whenReady()
  .then(async () => {
    settingsFile = join(app.getPath("userData"), "client-settings.json");
    state = await loadClientState(settingsFile);
    await saveClientState(settingsFile, state);
    app.setAsDefaultProtocolClient("streamerai");
    const remoteSession = session.fromPartition("persist:streamerai-server");
    remoteSession.setPermissionRequestHandler(
      (_contents, permission, callback, details) =>
        callback(
          permission === "fullscreen" &&
            !!state.selected &&
            isServerNavigation(details.requestingUrl, state.selected.url),
        ),
    );
    remoteSession.setPermissionCheckHandler(
      (_contents, permission, origin) =>
        permission === "fullscreen" &&
        !!state.selected &&
        isServerNavigation(origin, state.selected.url),
    );
    remoteSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (state.selected && isServerNavigation(details.url, state.selected.url))
        details.requestHeaders["X-Streamer-Client-Id"] = state.clientId;
      callback({ requestHeaders: details.requestHeaders });
    });
    ipcMain.handle("client:state", (event) => {
      trusted(event);
      return state;
    });
    ipcMain.handle("client:discover", async (event) => {
      trusted(event);
      scanning ??= discoverServers();
      try {
        return await scanning;
      } finally {
        scanning = null;
      }
    });
    ipcMain.handle("client:connect", async (event, input: unknown) => {
      trusted(event);
      if (!input || typeof input !== "object")
        throw new Error("Invalid server choice.");
      const candidate = input as {
        address?: unknown;
        expectedServerId?: unknown;
      };
      if (
        typeof candidate.address !== "string" ||
        (candidate.expectedServerId !== undefined &&
          typeof candidate.expectedServerId !== "string")
      )
        throw new Error("Invalid server address.");
      await connect(candidate.address, candidate.expectedServerId);
    });
    ipcMain.handle("client:forget", async (event) => {
      trusted(event);
      if (state.selected)
        await remoteSession.clearStorageData({ origin: state.selected.url });
      state = { ...state, selected: null };
      await saveClientState(settingsFile, state);
      remote?.destroy();
      remote = null;
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "StreamerAI",
          submenu: [
            {
              label: "Choose home server…",
              accelerator: "CmdOrCtrl+,",
              click: showChooser,
            },
            {
              label: "Reload",
              accelerator: "CmdOrCtrl+R",
              click: () => remote?.reload(),
            },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
      ]),
    );
    showChooser();
    if (smokeUrl) {
      const shellWindow = chooser as BrowserWindow | null;
      if (!shellWindow) throw new Error("Missing chooser window");
      await new Promise<void>((resolve) =>
        shellWindow.webContents.once("did-finish-load", () => resolve()),
      );
      const local = await shellWindow.webContents.executeJavaScript(
        "({node:typeof process, bridge:typeof window.streamerClient})",
      );
      await connect(smokeUrl, "smoke-server");
      const remoteWindow = remote as BrowserWindow | null;
      if (!remoteWindow) throw new Error("Missing server window");
      const remoteState = await remoteWindow.webContents.executeJavaScript(
        "({node:typeof process, bridge:typeof window.streamerClient, title:document.title})",
      );
      if (
        local.node !== "undefined" ||
        local.bridge !== "object" ||
        remoteState.node !== "undefined" ||
        remoteState.bridge !== "undefined"
      )
        throw new Error("Client trust boundary failed");
      console.log(
        "CLIENT_SMOKE " +
          JSON.stringify({
            shell: local,
            remote: remoteState,
            sandbox: REMOTE_WEB_PREFERENCES.sandbox,
            contextIsolation: REMOTE_WEB_PREFERENCES.contextIsolation,
          }),
      );
      app.exit(0);
      return;
    }
    if (pendingLink) {
      const link = pendingLink;
      pendingLink = undefined;
      await connect(link).catch(showError);
    } else if (state.selected)
      await connect(state.selected.url, state.selected.serverId).catch(
        showError,
      );
  })
  .catch(showError);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (remote) {
    remote.show();
    remote.focus();
  } else showChooser();
});
