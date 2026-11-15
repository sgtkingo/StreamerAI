import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectAgentHosts,
  mcpConnectorLink,
  McpConnectorTickets,
  parseMcpConnectorLink,
} from "../src/mcp/mcp-connector.js";
import {
  McpAccessTokens,
  McpHostInstaller,
  type McpHostEnvironment,
} from "../src/mcp/mcp-host-installer.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";

const bridge = { command: "C:\\Node\\node.exe", args: ["C:\\App\\stdio.js"] };
const server = "http://127.0.0.1:4400";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function userEnvironment(): McpHostEnvironment {
  const home = mkdtempSync(join(tmpdir(), "streamerai-connector-"));
  homes.push(home);
  return { platform: "linux", home, env: { PATH: "" }, serviceAccount: false };
}
/** Routes connector requests straight to the ticket store, as the server routes do. */
function fakeServer(tickets: McpConnectorTickets): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status });
    if (url === `${server}/api/v1/mcp/connector/redeem`) {
      const redeemed = await tickets.redeem(
        body.ticket,
        body.hosts,
        body.detected,
      );
      return redeemed
        ? json(200, redeemed)
        : json(403, { error: { message: "This connect link has expired." } });
    }
    if (url === `${server}/api/v1/mcp/connector/report`)
      return (await tickets.report(body.ticket, body.results))
        ? json(200, { ok: true })
        : json(403, { error: { message: "expired" } });
    return json(404, {});
  }) as typeof fetch;
}

describe("agent connector links", () => {
  it("accepts only loopback servers and well-formed tickets", () => {
    const ticket = "a".repeat(43);
    expect(parseMcpConnectorLink(mcpConnectorLink(server, ticket))).toEqual({
      server,
      ticket,
    });
    expect(
      parseMcpConnectorLink(
        `streamerai-agent://connect/?server=${encodeURIComponent(`${server}/`)}&ticket=${ticket}`,
      ),
    ).toEqual({ server, ticket });
    for (const link of [
      mcpConnectorLink("http://192.168.1.20:4400", ticket),
      mcpConnectorLink("https://127.0.0.1:4400", ticket),
      mcpConnectorLink("http://user@127.0.0.1:4400", ticket),
      mcpConnectorLink(server, "short"),
      `https://connect?server=${server}&ticket=${ticket}`,
      "streamerai-agent://other?server=x",
    ])
      expect(parseMcpConnectorLink(link)).toBeNull();
  });
});

describe("agent connector tickets", () => {
  it("redeem once, revoke credentials the connector did not write and expire", async () => {
    let now = 1_000_000;
    const tokens = new McpAccessTokens(new NonPersistentMemorySecretStore());
    const tickets = new McpConnectorTickets(tokens, () => now);
    const { ticket } = tickets.create("viewer-1");
    expect(tickets.status(ticket, "viewer-1").state).toBe("waiting");
    expect(tickets.status(ticket, "viewer-2").state).toBe("expired");

    const redeemed = await tickets.redeem(
      ticket,
      ["claude-code", "codex", "nope"],
      ["claude-code", "codex", "cursor"],
    );
    expect(redeemed?.profileId).toBe("viewer-1");
    expect(Object.keys(redeemed!.tokens).sort()).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(await tickets.redeem(ticket, ["cursor"], [])).toBeNull();
    expect(tickets.status(ticket, "viewer-1").state).toBe("connecting");

    expect(
      await tickets.report(ticket, [
        { id: "claude-code", ok: true },
        { id: "codex", ok: false, message: "read-only" },
        { id: "cursor", ok: true },
      ]),
    ).toBe(true);
    const status = tickets.status(ticket, "viewer-1");
    expect(status).toMatchObject({
      state: "done",
      detected: ["claude-code", "codex", "cursor"],
    });
    // A host that received no credential can never report success.
    expect(status.results).toEqual([
      { id: "claude-code", ok: true },
      { id: "codex", ok: false, message: "read-only" },
      { id: "cursor", ok: false },
    ]);
    await expect(
      tokens.verify(redeemed!.tokens["claude-code"]!),
    ).resolves.toMatchObject({ profileId: "viewer-1" });
    await expect(tokens.verify(redeemed!.tokens.codex!)).resolves.toBeNull();
    expect(await tickets.report(ticket, [])).toBe(false);

    const late = tickets.create("viewer-1").ticket;
    now += 11 * 60_000;
    expect(await tickets.redeem(late, ["codex"], [])).toBeNull();
    expect(tickets.status(late, "viewer-1").state).toBe("expired");
  });
});

describe("connectAgentHosts", () => {
  it("writes detected hosts in the user's account and reports to the service", async () => {
    const environment = userEnvironment();
    mkdirSync(join(environment.home, ".cursor"));
    mkdirSync(join(environment.home, ".codex"));
    writeFileSync(
      join(environment.home, ".claude.json"),
      JSON.stringify({ theme: "dark" }),
    );
    const tokens = new McpAccessTokens(new NonPersistentMemorySecretStore());
    const tickets = new McpConnectorTickets(tokens);
    const { ticket } = tickets.create("viewer-1");
    const lines: string[] = [];
    const outcome = await connectAgentHosts({
      link: mcpConnectorLink(server, ticket),
      environment,
      bridge,
      fetch: fakeServer(tickets),
      log: (line) => lines.push(line),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.results.map((result) => result.id).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
    ]);
    expect(outcome.results.every((result) => result.ok)).toBe(true);
    const claude = JSON.parse(
      readFileSync(join(environment.home, ".claude.json"), "utf8"),
    );
    expect(claude.theme).toBe("dark");
    const entry = claude.mcpServers["streamer-ai"];
    expect(entry).toMatchObject({
      type: "stdio",
      command: bridge.command,
      env: {
        STREAMERAI_MCP_BASE_URL: server,
        STREAMERAI_MCP_PROFILE_ID: "viewer-1",
      },
    });
    await expect(
      tokens.matches(entry.env.STREAMERAI_MCP_TOKEN, "viewer-1", "claude-code"),
    ).resolves.toBe(true);
    expect(tickets.status(ticket, "viewer-1").state).toBe("done");
    expect(lines[0]).toMatch(/^Found: /);

    // The service account sees the connection through its credentials only.
    const serviceView = new McpHostInstaller({
      tokens,
      baseUrl: server,
      bridge: () => bridge,
      environment: () => ({
        platform: "win32",
        home: "C:\\Windows\\ServiceProfiles\\LocalService",
        env: {},
        serviceAccount: true,
      }),
    });
    const overview = await serviceView.overview("viewer-1");
    const cursor = overview.hosts.find((host) => host.id === "cursor")!;
    expect(cursor.state).toBe("installed");
    expect(cursor.connection?.issuedAt).toBeTruthy();
    expect(cursor.connection?.seenAt).toBeUndefined();
    expect(cursor.configPath).toMatch(/^~/);
    expect(
      overview.hosts.find((host) => host.id === "claude-desktop")?.state,
    ).toBe("not-detected");
    await expect(serviceView.install("viewer-1", "cursor")).rejects.toThrow(
      "background service",
    );

    // The bridge announcing itself ends "restart required".
    const cursorToken = JSON.parse(
      readFileSync(join(environment.home, ".cursor", "mcp.json"), "utf8"),
    ).mcpServers["streamer-ai"].env.STREAMERAI_MCP_TOKEN;
    await expect(tokens.markSeen(cursorToken)).resolves.toMatchObject({
      seenAt: expect.any(String),
    });
    expect(
      (await serviceView.overview("viewer-1")).hosts.find(
        (host) => host.id === "cursor",
      )?.connection?.seenAt,
    ).toBeTruthy();

    await serviceView.remove("viewer-1", "cursor");
    await expect(tokens.verify(cursorToken)).resolves.toBeNull();
  });

  it("reports an invalid config without issuing its credential", async () => {
    const environment = userEnvironment();
    mkdirSync(join(environment.home, ".cursor"));
    writeFileSync(join(environment.home, ".cursor", "mcp.json"), "{ broken");
    const tokens = new McpAccessTokens(new NonPersistentMemorySecretStore());
    const tickets = new McpConnectorTickets(tokens);
    const { ticket } = tickets.create("viewer-1");
    const outcome = await connectAgentHosts({
      link: mcpConnectorLink(server, ticket),
      environment,
      bridge,
      fetch: fakeServer(tickets),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.results).toEqual([
      {
        id: "cursor",
        ok: false,
        message: expect.stringContaining("not valid JSON"),
      },
    ]);
    expect(await tokens.describe("viewer-1", "cursor")).toBeNull();
    expect(
      readFileSync(join(environment.home, ".cursor", "mcp.json"), "utf8"),
    ).toBe("{ broken");
    expect(tickets.status(ticket, "viewer-1").results).toHaveLength(1);
  });

  it("writes nothing when the ticket is rejected", async () => {
    const environment = userEnvironment();
    mkdirSync(join(environment.home, ".cursor"));
    const tickets = new McpConnectorTickets(
      new McpAccessTokens(new NonPersistentMemorySecretStore()),
    );
    const outcome = await connectAgentHosts({
      link: mcpConnectorLink(server, "b".repeat(43)),
      environment,
      bridge,
      fetch: fakeServer(tickets),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/did not accept/);
    expect(() =>
      readFileSync(join(environment.home, ".cursor", "mcp.json")),
    ).toThrow();
  });
});
