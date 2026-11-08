import { contextBridge, ipcRenderer } from "electron";
import type { ClientBridge } from "./types.js";
const bridge: ClientBridge = Object.freeze({
  state: () => ipcRenderer.invoke("client:state"),
  discover: () => ipcRenderer.invoke("client:discover"),
  connect: (input: Parameters<ClientBridge["connect"]>[0]) =>
    ipcRenderer.invoke("client:connect", input),
  forget: () => ipcRenderer.invoke("client:forget"),
});
contextBridge.exposeInMainWorld("streamerClient", bridge);
