import { isIP } from "node:net";

export const MANUAL_AGENT_SETTING_KEY = "inference.manual-agent";

export interface ManualAgentConfig {
  baseUrl: string;
  model: string;
}

function localHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "ollama", "host.docker.internal"].includes(host)) {
    return true;
  }
  if (isIP(host) === 4) {
    const parts = host.split(".").map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    );
  }
  if (isIP(host) === 6) {
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    return (
      host === "::1" ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80
    );
  }
  return false;
}

export function parseManualAgentConfig(value: unknown): ManualAgentConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("Enter a local API address and model name.");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.baseUrl !== "string" || typeof input.model !== "string") {
    throw new Error("Enter a local API address and model name.");
  }
  const raw = input.baseUrl.trim();
  const model = input.model.trim();
  if (
    !raw ||
    raw.length > 512 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model)
  ) {
    throw new Error("Enter a valid local API address and model name.");
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error("Enter a valid local API address.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !localHost(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Use a local or private HTTP(S) API address without a path or credentials.",
    );
  }
  return { baseUrl: url.origin, model };
}
