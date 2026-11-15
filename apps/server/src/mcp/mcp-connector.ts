import { createHash, randomBytes } from "node:crypto";
import {
  currentMcpHostEnvironment,
  detectMcpHosts,
  isLoopbackBaseUrl,
  isMcpHostId,
  mcpBridgeEntry,
  McpHostConfigError,
  mcpHostName,
  prepareMcpHostWrite,
  resolveMcpBridge,
  type McpAccessTokens,
  type McpBridgeCommand,
  type McpHostEnvironment,
  type McpHostId,
  type McpHostWrite,
} from "./mcp-host-installer.js";

/**
 * The installed server runs as a service account and cannot see the agent
 * hosts of the person using the computer. The connector is a short-lived
 * helper started as that person (through the `streamerai-agent:` link the
 * setup registers, or a copied command). It redeems a one-time ticket created
 * by the household owner, receives per-host credentials and writes the host
 * configurations in the person's own account.
 */
export const MCP_CONNECTOR_SCHEME = "streamerai-agent";

export interface McpConnectorResult {
  readonly id: McpHostId;
  readonly ok: boolean;
  readonly message?: string;
}
export type McpConnectorState = "waiting" | "connecting" | "done" | "expired";
export interface McpConnectorStatus {
  readonly state: McpConnectorState;
  readonly expiresAt: string;
  /** Hosts the connector found in the person's account. */
  readonly detected: McpHostId[];
  readonly results: McpConnectorResult[];
}
export interface McpConnectorRedemption {
  readonly profileId: string;
  readonly baseUrl: string;
  readonly tokens: Partial<Record<McpHostId, string>>;
}

export function mcpConnectorLink(baseUrl: string, ticket: string): string {
  const query = new URLSearchParams({ server: baseUrl, ticket });
  return `${MCP_CONNECTOR_SCHEME}://connect?${query.toString()}`;
}
const TICKET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
export function parseMcpConnectorLink(
  link: string,
): { server: string; ticket: string } | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== `${MCP_CONNECTOR_SCHEME}:` ||
    url.hostname !== "connect" ||
    !["", "/"].includes(url.pathname)
  )
    return null;
  const server = url.searchParams.get("server")?.replace(/\/+$/, "") ?? "";
  const ticket = url.searchParams.get("ticket") ?? "";
  if (!isLoopbackBaseUrl(server) || !TICKET_PATTERN.test(ticket)) return null;
  return { server, ticket };
}

type Ticket = {
  readonly profileId: string;
  readonly expiresAt: number;
  state: Exclude<McpConnectorState, "expired">;
  issued: McpHostId[];
  detected: McpHostId[];
  results: McpConnectorResult[];
};
const TICKET_TTL_MS = 10 * 60_000;
const MAX_TICKETS = 32;
function ticketKey(ticket: string) {
  return createHash("sha256").update(ticket).digest("hex");
}
function hostIds(value: unknown): McpHostId[] {
  return Array.isArray(value)
    ? [...new Set(value.filter(isMcpHostId))].slice(0, 16)
    : [];
}

/** One-time, owner-created tickets that let the user-side connector obtain host credentials. */
export class McpConnectorTickets {
  readonly #tickets = new Map<string, Ticket>();
  constructor(
    private readonly tokens: McpAccessTokens,
    private readonly now: () => number = Date.now,
  ) {}
  private prune() {
    const now = this.now();
    for (const [key, ticket] of this.#tickets)
      if (ticket.expiresAt <= now) this.#tickets.delete(key);
  }
  private find(ticket: string) {
    if (typeof ticket !== "string" || !TICKET_PATTERN.test(ticket)) return null;
    this.prune();
    return this.#tickets.get(ticketKey(ticket)) ?? null;
  }
  create(profileId: string): { ticket: string; expiresAt: string } {
    this.prune();
    while (this.#tickets.size >= MAX_TICKETS)
      this.#tickets.delete(this.#tickets.keys().next().value!);
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + TICKET_TTL_MS;
    this.#tickets.set(ticketKey(ticket), {
      profileId,
      expiresAt,
      state: "waiting",
      issued: [],
      detected: [],
      results: [],
    });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }
  status(ticket: string, profileId: string): McpConnectorStatus {
    const found = this.find(ticket);
    if (!found || found.profileId !== profileId)
      return {
        state: "expired",
        expiresAt: new Date(this.now()).toISOString(),
        detected: [],
        results: [],
      };
    return {
      state: found.state,
      expiresAt: new Date(found.expiresAt).toISOString(),
      detected: [...found.detected],
      results: [...found.results],
    };
  }
  /** Issues credentials for the requested hosts. Each ticket redeems once. */
  async redeem(
    ticket: string,
    hosts: unknown,
    detected: unknown,
  ): Promise<{
    profileId: string;
    tokens: Partial<Record<McpHostId, string>>;
  } | null> {
    const found = this.find(ticket);
    if (!found || found.state !== "waiting") return null;
    found.state = "connecting";
    found.detected = hostIds(detected);
    found.issued = hostIds(hosts);
    const tokens: Partial<Record<McpHostId, string>> = {};
    for (const id of found.issued)
      tokens[id] = await this.tokens.issue(found.profileId, id);
    return { profileId: found.profileId, tokens };
  }
  /** Records the connector's outcome and revokes credentials it did not write. */
  async report(ticket: string, results: unknown): Promise<boolean> {
    const found = this.find(ticket);
    if (!found || found.state !== "connecting") return false;
    const reported = (Array.isArray(results) ? results : [])
      .map((item): McpConnectorResult | null => {
        const value =
          item && typeof item === "object"
            ? (item as Record<string, unknown>)
            : {};
        if (!isMcpHostId(value.id)) return null;
        return {
          id: value.id,
          ok: value.ok === true && found.issued.includes(value.id),
          ...(typeof value.message === "string" && value.message
            ? { message: value.message.slice(0, 300) }
            : {}),
        };
      })
      .filter((item): item is McpConnectorResult => item !== null)
      .filter(
        (item, index, all) =>
          all.findIndex((other) => other.id === item.id) === index,
      )
      .slice(0, 16);
    for (const id of found.issued)
      if (!reported.some((item) => item.id === id && item.ok))
        await this.tokens.revoke(found.profileId, id);
    found.results = reported;
    found.state = "done";
    return true;
  }
}

export interface ConnectAgentHostsOptions {
  readonly link: string;
  readonly environment?: McpHostEnvironment;
  readonly bridge?: McpBridgeCommand | null;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
}
export interface ConnectAgentHostsOutcome {
  readonly ok: boolean;
  readonly results: McpConnectorResult[];
  readonly message?: string;
}

async function post(
  fetcher: typeof fetch,
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const error =
      data.error && typeof data.error === "object"
        ? (data.error as Record<string, unknown>)
        : {};
    throw new Error(
      typeof error.message === "string"
        ? error.message
        : `StreamerAI answered with HTTP ${response.status}.`,
    );
  }
  return data;
}

/**
 * Runs in the person's own account: finds agent hosts, redeems the ticket for
 * their credentials, writes the host configurations and reports back.
 */
export async function connectAgentHosts(
  options: ConnectAgentHostsOptions,
): Promise<ConnectAgentHostsOutcome> {
  const log = options.log ?? (() => {});
  const fetcher = options.fetch ?? fetch;
  const link = parseMcpConnectorLink(options.link);
  if (!link)
    return {
      ok: false,
      results: [],
      message:
        "This is not a valid StreamerAI connect link. Start again from StreamerAI Settings.",
    };
  const environment = options.environment ?? currentMcpHostEnvironment();
  const bridge =
    options.bridge === undefined ? resolveMcpBridge() : options.bridge;
  const detected = detectMcpHosts(environment);
  const results: McpConnectorResult[] = [];
  const writes = new Map<McpHostId, McpHostWrite>();
  if (!bridge)
    for (const id of detected)
      results.push({
        id,
        ok: false,
        message: "The StreamerAI MCP bridge is missing from this installation.",
      });
  else
    for (const id of detected) {
      try {
        writes.set(id, prepareMcpHostWrite(environment, id));
      } catch (error) {
        results.push({
          id,
          ok: false,
          message:
            error instanceof McpHostConfigError
              ? error.message
              : "The configuration could not be read.",
        });
      }
    }
  log(
    detected.length
      ? `Found: ${detected.map(mcpHostName).join(", ")}.`
      : "No supported agent was found in this user account.",
  );
  let redemption: McpConnectorRedemption;
  try {
    const data = await post(
      fetcher,
      `${link.server}/api/v1/mcp/connector/redeem`,
      {
        ticket: link.ticket,
        hosts: [...writes.keys()],
        detected,
      },
    );
    const tokens =
      data.tokens && typeof data.tokens === "object"
        ? (data.tokens as Record<string, unknown>)
        : {};
    if (typeof data.profileId !== "string")
      throw new Error("StreamerAI returned an incomplete answer.");
    redemption = {
      profileId: data.profileId,
      baseUrl: link.server,
      tokens: Object.fromEntries(
        Object.entries(tokens).filter(
          (item): item is [McpHostId, string] =>
            isMcpHostId(item[0]) && typeof item[1] === "string",
        ),
      ),
    };
  } catch (error) {
    return {
      ok: false,
      results,
      message: `StreamerAI did not accept this connect link: ${
        error instanceof Error ? error.message : "unknown error"
      } Start again from StreamerAI Settings.`,
    };
  }
  for (const [id, write] of writes) {
    const token = redemption.tokens[id];
    if (!token) {
      results.push({ id, ok: false, message: "No credential was issued." });
      continue;
    }
    try {
      write.commit(
        mcpBridgeEntry(
          bridge!,
          redemption.baseUrl,
          redemption.profileId,
          token,
        ),
      );
      results.push({ id, ok: true });
      log(`✓ ${mcpHostName(id)}: ${write.path}`);
    } catch (error) {
      results.push({
        id,
        ok: false,
        message:
          error instanceof McpHostConfigError
            ? error.message
            : "The configuration could not be written.",
      });
    }
  }
  for (const result of results)
    if (!result.ok) log(`✗ ${mcpHostName(result.id)}: ${result.message ?? ""}`);
  try {
    await post(fetcher, `${link.server}/api/v1/mcp/connector/report`, {
      ticket: link.ticket,
      results,
    });
  } catch (error) {
    return {
      ok: false,
      results,
      message: `The result could not be reported to StreamerAI: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }
  return { ok: results.some((result) => result.ok), results };
}
