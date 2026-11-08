import { normalizeServerUrl } from "@streamer-ai/discovery";

export const REMOTE_WEB_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
});
export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 4096 &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export function isServerNavigation(value: string, serverUrl: string): boolean {
  try {
    return new URL(value).origin === normalizeServerUrl(serverUrl);
  } catch {
    return false;
  }
}
export function parseConnectionInput(value: unknown): {
  url: string;
  expectedServerId?: string;
} {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Enter a server address or scan its connection QR code.");
  if (value.startsWith("streamerai://")) {
    const link = new URL(value);
    if (link.hostname !== "connect" || link.username || link.password)
      throw new Error("Invalid server connection link.");
    const serverId = link.searchParams.get("serverId");
    if (serverId && !/^[a-zA-Z0-9:_-]{1,160}$/.test(serverId))
      throw new Error("Invalid server identity.");
    return {
      url: normalizeServerUrl(link.searchParams.get("url") ?? ""),
      ...(serverId ? { expectedServerId: serverId } : {}),
    };
  }
  return { url: normalizeServerUrl(value) };
}
export function isTrustedShellFrame(
  frame: { url: string; parent: unknown } | null,
  shellUrl: string,
): boolean {
  return !!frame && frame.parent === null && frame.url === shellUrl;
}
