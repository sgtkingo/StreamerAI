import type { ServerAnnouncement } from "@streamer-ai/discovery";
import type { ClientState } from "./types.js";
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let selected: ServerAnnouncement | null = null;
const error = (reason: unknown) => {
  element("error").textContent =
    reason instanceof Error
      ? reason.message.replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          "",
        )
      : "The server could not be opened.";
};
function showState(state: ClientState) {
  selected = state.selected;
  element("client-id").textContent = `This client: ${state.clientId}`;
  element("selected").hidden = !selected;
  element("selected-name").textContent = selected
    ? `${selected.name} — ${selected.url}`
    : "";
}
async function connect(address: string, expectedServerId?: string) {
  element("error").textContent = "";
  element<HTMLButtonElement>("connect").disabled = true;
  try {
    await window.streamerClient.connect({ address, expectedServerId });
    showState(await window.streamerClient.state());
  } catch (reason) {
    error(reason);
  } finally {
    element<HTMLButtonElement>("connect").disabled = false;
  }
}
async function discover() {
  element<HTMLButtonElement>("refresh").disabled = true;
  element("discovery-status").textContent = "Looking for your server…";
  element("servers").replaceChildren();
  try {
    const servers = await window.streamerClient.discover();
    element("discovery-status").textContent = servers.length
      ? "Choose your home server to connect."
      : "No server found. You can enter its address below.";
    for (const server of servers) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "server";
      const name = document.createElement("strong");
      name.textContent = server.name;
      const address = document.createElement("small");
      address.textContent = server.url;
      button.append(name, address);
      button.addEventListener(
        "click",
        () => void connect(server.url, server.serverId),
      );
      element("servers").append(button);
    }
  } catch {
    element("discovery-status").textContent =
      "Automatic discovery is unavailable. Enter the server address below.";
  } finally {
    element<HTMLButtonElement>("refresh").disabled = false;
  }
}
element("refresh").addEventListener("click", () => void discover());
element("manual-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void connect(element<HTMLInputElement>("address").value.trim());
});
element("reconnect").addEventListener("click", () => {
  if (selected) void connect(selected.url, selected.serverId);
});
element("forget").addEventListener("click", () => {
  void window.streamerClient
    .forget()
    .then(() => window.streamerClient.state())
    .then(showState)
    .catch(error);
});
void window.streamerClient.state().then(showState).catch(error);
window.addEventListener("focus", () => {
  void window.streamerClient.state().then(showState).catch(error);
});
void discover();
