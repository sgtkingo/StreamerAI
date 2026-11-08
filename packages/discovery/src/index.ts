import dgram, { type Socket } from "node:dgram";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";

export const DISCOVERY_PROTOCOL = "streamerai-discovery" as const;
export const DISCOVERY_VERSION = 1 as const;
export const DISCOVERY_PORT = 47777;
export const DISCOVERY_GROUP = "239.255.77.77";
const MAX_PACKET_BYTES = 4096;
export interface ServerAnnouncement {
  protocol: typeof DISCOVERY_PROTOCOL;
  version: typeof DISCOVERY_VERSION;
  serverId: string;
  householdId: string | null;
  name: string;
  url: string;
}
export interface DiscoveryAnnouncement extends ServerAnnouncement {
  nonce: string;
}
export type AnnouncementInput = Omit<
  ServerAnnouncement,
  "protocol" | "version"
>;

export function normalizeServerUrl(input: string): string {
  const url = new URL(input.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error(
      "Enter the server's HTTP or HTTPS address without a path, password or setup key.",
    );
  if (!url.hostname || url.hostname.length > 253)
    throw new Error("Invalid server address.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const parts = host.split(".").map(Number);
  const local =
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    (!host.includes(".") && !host.includes(":")) ||
    (host.includes(":") && /^(fc|fd|fe80:)/.test(host)) ||
    (parts.length === 4 &&
      parts.every(
        (part) => Number.isInteger(part) && part >= 0 && part <= 255,
      ) &&
      (parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
        (parts[0] === 169 && parts[1] === 254)));
  if (url.protocol === "http:" && !local)
    throw new Error("Use HTTPS for a server outside your local network.");
  return url.origin;
}
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32);
export function parseAnnouncement(
  input: unknown,
  nonce?: string,
): ServerAnnouncement | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const item = input as Record<string, unknown>;
  if (
    item.protocol !== DISCOVERY_PROTOCOL ||
    item.version !== DISCOVERY_VERSION ||
    !text(item.serverId, 160) ||
    !(item.householdId === null || text(item.householdId, 160)) ||
    !text(item.name, 120) ||
    !text(item.url, 2048) ||
    (nonce !== undefined && item.nonce !== nonce)
  )
    return null;
  try {
    return {
      protocol: DISCOVERY_PROTOCOL,
      version: DISCOVERY_VERSION,
      serverId: item.serverId,
      householdId: item.householdId as string | null,
      name: item.name,
      url: normalizeServerUrl(item.url),
    };
  } catch {
    return null;
  }
}
function parsePacket(data: Buffer): unknown {
  if (data.length > MAX_PACKET_BYTES) return null;
  try {
    return JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}
function addresses() {
  return Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal);
}
async function bind(
  socket: Socket,
  port: number,
  address: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      socket.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      socket.off("error", failed);
      resolve();
    };
    socket.once("error", failed);
    socket.once("listening", ready);
    socket.bind(port, address);
  });
}
const close = (socket: Socket) =>
  new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
export interface DiscoveryResponderOptions {
  getAnnouncement(): AnnouncementInput | null;
  port?: number;
  group?: string | null;
  address?: string;
}
/** Discovery is a hint; clients verify HTTP identity before completing server pairing. */
export async function startDiscoveryResponder(
  options: DiscoveryResponderOptions,
) {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const group = options.group === undefined ? DISCOVERY_GROUP : options.group;
  const rates = new Map<string, { start: number; count: number }>();
  socket.on("message", (packet, remote) => {
    const input = parsePacket(packet) as Record<string, unknown> | null;
    if (
      !input ||
      input.protocol !== DISCOVERY_PROTOCOL ||
      input.version !== DISCOVERY_VERSION ||
      input.type !== "discover" ||
      typeof input.nonce !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.nonce)
    )
      return;
    const now = Date.now();
    if (rates.size > 512)
      for (const [ip, budget] of rates)
        if (budget.start < now - 60_000) rates.delete(ip);
    if (rates.size > 512 && !rates.has(remote.address)) return;
    const budget = rates.get(remote.address);
    const next =
      budget && budget.start > now - 60_000 ? budget : { start: now, count: 0 };
    rates.set(remote.address, next);
    if (++next.count > 60) return;
    let source: AnnouncementInput | null;
    try {
      source = options.getAnnouncement();
    } catch {
      return;
    }
    if (!source) return;
    const announcement = parseAnnouncement({
      ...source,
      protocol: DISCOVERY_PROTOCOL,
      version: DISCOVERY_VERSION,
    });
    if (!announcement) return;
    const response = Buffer.from(
      JSON.stringify({ ...announcement, nonce: input.nonce }),
    );
    if (response.length <= MAX_PACKET_BYTES)
      socket.send(response, remote.port, remote.address, () => undefined);
  });
  try {
    await bind(
      socket,
      options.port ?? DISCOVERY_PORT,
      options.address ?? "0.0.0.0",
    );
    socket.on("error", () => undefined);
    if (group) {
      let joined = false;
      for (const item of addresses())
        try {
          socket.addMembership(group, item.address);
          joined = true;
        } catch {
          /* Interface may not support multicast. */
        }
      if (!joined)
        try {
          socket.addMembership(group);
        } catch {
          /* Unicast/manual discovery still works. */
        }
      socket.setMulticastTTL(1);
    }
    return { port: socket.address().port, close: () => close(socket) };
  } catch (error) {
    await close(socket);
    throw error;
  }
}
export interface DiscoverOptions {
  timeoutMs?: number;
  port?: number;
  group?: string | null;
  targets?: string[];
}
export async function discoverServers(
  options: DiscoverOptions = {},
): Promise<ServerAnnouncement[]> {
  const timeout = Math.max(50, Math.min(15_000, options.timeoutMs ?? 1800));
  const port = options.port ?? DISCOVERY_PORT,
    group = options.group === undefined ? DISCOVERY_GROUP : options.group;
  const socket = dgram.createSocket("udp4"),
    nonce = randomUUID(),
    found = new Map<string, ServerAnnouncement>();
  socket.on("message", (packet) => {
    const item = parseAnnouncement(parsePacket(packet), nonce);
    if (item) found.set(`${item.serverId}:${item.url}`, item);
  });
  try {
    await bind(socket, 0, "0.0.0.0");
    socket.on("error", () => undefined);
    socket.setBroadcast(true);
    socket.setMulticastTTL(1);
    const targets = new Set(options.targets ?? ["255.255.255.255"]);
    if (group) targets.add(group);
    if (!options.targets)
      for (const item of addresses()) {
        const ip = item.address.split(".").map(Number),
          mask = item.netmask.split(".").map(Number);
        targets.add(
          ip.map((byte, index) => byte | (~mask[index]! & 255)).join("."),
        );
      }
    const packet = Buffer.from(
      JSON.stringify({
        protocol: DISCOVERY_PROTOCOL,
        version: DISCOVERY_VERSION,
        type: "discover",
        nonce,
      }),
    );
    const send = () => {
      for (const target of targets)
        socket.send(packet, port, target, () => undefined);
    };
    send();
    const retry = setTimeout(send, Math.floor(timeout / 2));
    await new Promise((resolve) => setTimeout(resolve, timeout));
    clearTimeout(retry);
    return [...found.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.url.localeCompare(b.url),
    );
  } finally {
    await close(socket);
  }
}
export async function verifyDiscoveredServer(
  input: string,
  options: {
    expectedServerId?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
  } = {},
): Promise<ServerAnnouncement> {
  const url = normalizeServerUrl(input);
  const response = await (options.fetch ?? fetch)(
    url + "/api/v1/installation/discovery",
    {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.max(100, Math.min(options.timeoutMs ?? 5000, 15_000)),
      ),
    },
  );
  if (!response.ok)
    throw new Error(
      "The server could not be reached. Check its address and network connection.",
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Invalid server identity response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > MAX_PACKET_BYTES) {
      await reader.cancel();
      throw new Error("Invalid server identity response.");
    }
    chunks.push(part.value);
  }
  const serialized = Buffer.concat(chunks).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error(
      "This address did not return a StreamerAI server identity.",
    );
  }
  const announcement = parseAnnouncement(value);
  if (
    !announcement ||
    (options.expectedServerId &&
      options.expectedServerId !== announcement.serverId)
  )
    throw new Error(
      "The server identity changed. Choose the server again before pairing.",
    );
  return { ...announcement, url };
}
