import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexEntry,
  McpAccessTokens,
  McpHostInstaller,
  readCodexEntry,
  removeCodexEntry,
  type McpHostEnvironment,
} from "../src/mcp/mcp-host-installer.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";

const bridge = { command: "C:\\Node\\node.exe", args: ["C:\\App\\stdio.js"] };
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "streamerai-mcp-hosts-"));
  homes.push(home);
  const environment: McpHostEnvironment = {
    platform: "linux",
    home,
    env: { PATH: "" },
    serviceAccount: false,
  };
  const tokens = new McpAccessTokens(new NonPersistentMemorySecretStore());
  let current: typeof bridge | null = bridge;
  const installer = new McpHostInstaller({
    tokens,
    baseUrl: "http://127.0.0.1:4400",
    bridge: () => current,
    environment: () => environment,
  });
  return {
    home,
    tokens,
    installer,
    setBridge: (value: typeof bridge | null) => (current = value),
  };
}

describe("MCP host installer", () => {
  it("detects only hosts that exist for the server user", async () => {
    const { home, installer } = setup();
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ theme: "dark" }),
    );
    const overview = await installer.overview("viewer-1");
    expect(overview.bridge.available).toBe(true);
    expect(
      Object.fromEntries(overview.hosts.map((host) => [host.id, host.state])),
    ).toEqual({
      "claude-code": "available",
      codex: "available",
      "claude-desktop": "not-detected",
      cursor: "not-detected",
    });
  });

  it("installs into Claude Code without touching unrelated settings", async () => {
    const { home, installer, tokens } = setup();
    const path = join(home, ".claude.json");
    writeFileSync(
      path,
      JSON.stringify({
        theme: "dark",
        mcpServers: { other: { command: "other" } },
      }),
    );
    await installer.install("viewer-1", "claude-code");
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.other).toEqual({ command: "other" });
    expect(config.mcpServers["streamer-ai"]).toMatchObject({
      type: "stdio",
      command: bridge.command,
      args: bridge.args,
      env: {
        STREAMERAI_MCP_BASE_URL: "http://127.0.0.1:4400",
        STREAMERAI_MCP_PROFILE_ID: "viewer-1",
      },
    });
    const token = config.mcpServers["streamer-ai"].env.STREAMERAI_MCP_TOKEN;
    await expect(tokens.verify(token)).resolves.toEqual({
      profileId: "viewer-1",
      owner: "claude-code",
    });
    expect(existsSync(`${path}.streamerai.bak`)).toBe(true);
    const status = await installer.overview("viewer-1");
    expect(status.hosts.find((host) => host.id === "claude-code")?.state).toBe(
      "installed",
    );
    expect(
      (await installer.overview("viewer-2")).hosts.find(
        (host) => host.id === "claude-code",
      )?.state,
    ).toBe("other-profile");
  });

  it("writes and replaces a Codex table while preserving the rest of config.toml", async () => {
    const { home, installer } = setup();
    mkdirSync(join(home, ".codex"));
    const path = join(home, ".codex", "config.toml");
    writeFileSync(
      path,
      'model = "gpt-5"\n\n[mcp_servers.streamer-ai]\ncommand = "old"\n\n[mcp_servers.streamer-ai.env]\nX = "1"\n\n[profiles.fast]\nmodel = "mini"\n',
    );
    await installer.install("viewer-1", "codex");
    await installer.install("viewer-1", "codex");
    const text = readFileSync(path, "utf8");
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('[profiles.fast]\nmodel = "mini"');
    expect(text.match(/\[mcp_servers\.streamer-ai\]/g)).toHaveLength(1);
    expect(text).not.toContain('command = "old"');
    expect(readCodexEntry(text)).toMatchObject({
      command: bridge.command,
      args: bridge.args,
      env: { STREAMERAI_MCP_PROFILE_ID: "viewer-1" },
    });
    expect(
      (await installer.overview("viewer-1")).hosts.find(
        (host) => host.id === "codex",
      )?.state,
    ).toBe("installed");
    await installer.remove("viewer-1", "codex");
    const removed = readFileSync(path, "utf8");
    expect(removed).not.toContain("streamer-ai");
    expect(removed).toContain("[profiles.fast]");
  });

  it("reports an outdated connection after the bridge moves or the token is revoked", async () => {
    const { home, installer, tokens, setBridge } = setup();
    mkdirSync(join(home, ".cursor"));
    await installer.install("viewer-1", "cursor");
    setBridge({ command: "node", args: ["/new/stdio.js"] });
    expect(
      (await installer.overview("viewer-1")).hosts.find(
        (host) => host.id === "cursor",
      )?.state,
    ).toBe("outdated");
    setBridge(bridge);
    await tokens.revoke("viewer-1", "cursor");
    expect(
      (await installer.overview("viewer-1")).hosts.find(
        (host) => host.id === "cursor",
      )?.state,
    ).toBe("outdated");
  });

  it("refuses to overwrite an invalid JSON configuration", async () => {
    const { home, installer } = setup();
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ broken");
    await expect(installer.install("viewer-1", "cursor")).rejects.toThrow(
      "not valid JSON",
    );
    expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).toBe(
      "{ broken",
    );
  });

  it("does not remove another profile's connection", async () => {
    const { home, installer } = setup();
    mkdirSync(join(home, ".cursor"));
    await installer.install("viewer-1", "cursor");
    await installer.remove("viewer-2", "cursor");
    expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).toContain(
      "viewer-1",
    );
  });

  it("produces copyable manual commands with a working credential", async () => {
    const { installer, tokens } = setup();
    const manual = await installer.manual("viewer-1");
    expect(manual.claudeCommand).toMatch(
      /^claude mcp add streamer-ai --scope user --env STREAMERAI_MCP_BASE_URL=/,
    );
    expect(manual.codexCommand).toContain(`-- "${bridge.command}"`);
    await expect(
      tokens.verify(manual.env.STREAMERAI_MCP_TOKEN!),
    ).resolves.toEqual({ profileId: "viewer-1", owner: "manual" });
  });

  it("reports a missing bridge instead of writing a broken entry", async () => {
    const { home, installer, setBridge } = setup();
    mkdirSync(join(home, ".cursor"));
    setBridge(null);
    expect((await installer.overview("viewer-1")).bridge.available).toBe(false);
    await expect(installer.install("viewer-1", "cursor")).rejects.toThrow(
      "bridge is missing",
    );
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });
});

describe("MCP access tokens", () => {
  it("rejects forged, tampered and revoked tokens", async () => {
    const tokens = new McpAccessTokens(new NonPersistentMemorySecretStore());
    const token = await tokens.issue("viewer-1", "codex");
    await expect(tokens.verify(`${token}x`)).resolves.toBeNull();
    await expect(
      tokens.verify(token.replace(".codex.", ".cursor.")),
    ).resolves.toBeNull();
    await expect(tokens.verify("smcp.codex.AAAA.BBBB")).resolves.toBeNull();
    await tokens.revoke("viewer-1", "codex");
    await expect(tokens.verify(token)).resolves.toBeNull();
  });
});

describe("Codex TOML helpers", () => {
  it("round-trips Windows paths through the generated table", () => {
    const entry = {
      command: "C:\\Program Files\\StreamerAI\\runtime\\node.exe",
      args: ["C:\\Program Files\\StreamerAI\\app\\dist\\mcp\\stdio.js"],
      env: { STREAMERAI_MCP_PROFILE_ID: "p1" },
    };
    expect(readCodexEntry(codexEntry(entry))).toEqual(entry);
    expect(removeCodexEntry(`a = 1\n\n${codexEntry(entry)}\n`)).toBe("a = 1");
  });
});
