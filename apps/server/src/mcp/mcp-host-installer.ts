import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SecretStore } from "../stores/secret-store.js";

/** The name StreamerAI registers in every MCP host configuration. */
export const MCP_SERVER_NAME = "streamer-ai";
export const MCP_HOST_IDS = [
  "claude-code",
  "codex",
  "claude-desktop",
  "cursor",
] as const;
export type McpHostId = (typeof MCP_HOST_IDS)[number];
export type McpHostState =
  "not-detected" | "available" | "installed" | "outdated" | "other-profile";

export interface McpBridgeCommand {
  readonly command: string;
  readonly args: readonly string[];
}
export interface McpHostStatus {
  readonly id: McpHostId;
  readonly name: string;
  readonly state: McpHostState;
  readonly configPath: string;
  readonly restartHint: string;
  readonly message?: string;
  /** Present for a connected host: when it was connected and last started. */
  readonly connection?: McpConnection;
}
export interface McpHostsOverview {
  readonly bridge: { available: boolean; message?: string };
  /** The server runs as a service account whose home holds no user agent hosts. */
  readonly serviceAccount: boolean;
  /** Whether the user-side connector ships with this build. */
  readonly connector: { available: boolean };
  readonly hosts: McpHostStatus[];
}
export interface McpManualSetup {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly claudeCommand: string;
  readonly codexCommand: string;
  readonly json: string;
}

export interface McpHostEnvironment {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly serviceAccount: boolean;
}

type HostDefinition = {
  readonly id: McpHostId;
  readonly name: string;
  readonly format: "json" | "toml";
  readonly restartHint: string;
  readonly executables: readonly string[];
  configPath(environment: McpHostEnvironment): string;
  /** Paths whose existence shows the host has been installed or used. */
  markers(environment: McpHostEnvironment): string[];
  jsonEntry?(entry: BridgeEntry): Record<string, unknown>;
};
type BridgeEntry = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

function claudeConfigDirectory(environment: McpHostEnvironment) {
  return environment.env.CLAUDE_CONFIG_DIR || environment.home;
}
function codexHome(environment: McpHostEnvironment) {
  return environment.env.CODEX_HOME || join(environment.home, ".codex");
}
function claudeDesktopDirectory(environment: McpHostEnvironment) {
  if (environment.platform === "win32")
    return join(
      environment.env.APPDATA || join(environment.home, "AppData", "Roaming"),
      "Claude",
    );
  if (environment.platform === "darwin")
    return join(environment.home, "Library", "Application Support", "Claude");
  return join(
    environment.env.XDG_CONFIG_HOME || join(environment.home, ".config"),
    "Claude",
  );
}

const HOSTS: readonly HostDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    format: "json",
    restartHint: "Start a new Claude Code session to load StreamerAI tools.",
    executables: ["claude"],
    configPath: (environment) =>
      join(claudeConfigDirectory(environment), ".claude.json"),
    markers: (environment) => [
      join(claudeConfigDirectory(environment), ".claude.json"),
      join(environment.home, ".claude"),
    ],
    jsonEntry: (entry) => ({ type: "stdio", ...entry }),
  },
  {
    id: "codex",
    name: "Codex (ChatGPT)",
    format: "toml",
    restartHint: "Restart Codex (CLI, IDE extension or app) to load the tools.",
    executables: ["codex"],
    configPath: (environment) => join(codexHome(environment), "config.toml"),
    markers: (environment) => [codexHome(environment)],
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    format: "json",
    restartHint: "Quit Claude Desktop completely and open it again.",
    executables: [],
    configPath: (environment) =>
      join(claudeDesktopDirectory(environment), "claude_desktop_config.json"),
    markers: (environment) => [claudeDesktopDirectory(environment)],
  },
  {
    id: "cursor",
    name: "Cursor",
    format: "json",
    restartHint: "Reload Cursor, then enable streamer-ai in MCP settings.",
    executables: ["cursor"],
    configPath: (environment) => join(environment.home, ".cursor", "mcp.json"),
    markers: (environment) => [join(environment.home, ".cursor")],
  },
];

export function isMcpHostId(value: unknown): value is McpHostId {
  return (
    typeof value === "string" &&
    (MCP_HOST_IDS as readonly string[]).includes(value)
  );
}

export function currentMcpHostEnvironment(): McpHostEnvironment {
  const home = homedir();
  let serviceAccount = false;
  if (process.platform === "win32")
    serviceAccount = /\\(?:ServiceProfiles|systemprofile)(?:\\|$)/i.test(home);
  else {
    try {
      const shell = userInfo().shell ?? "";
      serviceAccount = /(?:nologin|\/false)$/.test(shell);
    } catch {
      serviceAccount = false;
    }
  }
  return { platform: process.platform, home, env: process.env, serviceAccount };
}

function findExecutable(name: string, environment: McpHostEnvironment) {
  const extensions =
    environment.platform === "win32"
      ? (environment.env.PATHEXT || ".EXE;.CMD;.BAT")
          .split(";")
          .filter(Boolean)
          .map((extension) => extension.toLowerCase())
      : [""];
  const directories = [
    ...(environment.env.PATH || environment.env.Path || "")
      .split(environment.platform === "win32" ? ";" : delimiter)
      .filter(Boolean),
    join(environment.home, ".local", "bin"),
  ];
  return directories.some((directory) =>
    extensions.some((extension) => {
      try {
        return statSync(join(directory, `${name}${extension}`)).isFile();
      } catch {
        return false;
      }
    }),
  );
}

/**
 * Locates a script in this directory (`stdio` bridge or `connect` helper) as
 * a command for the current Node runtime, in source or compiled builds.
 */
export function resolveMcpScript(
  name: "stdio" | "connect",
  moduleUrl: string = import.meta.url,
): McpBridgeCommand | null {
  const modulePath = fileURLToPath(moduleUrl);
  const directory = dirname(modulePath);
  if (modulePath.endsWith(".ts")) {
    const source = join(directory, `${name}.ts`);
    if (existsSync(source)) {
      try {
        const loader = createRequire(moduleUrl).resolve("tsx/esm");
        return {
          command: process.execPath,
          args: ["--import", pathToFileURL(loader).href, source],
        };
      } catch {
        // Fall through to a compiled script next to the sources.
      }
    }
    const compiled = resolve(
      directory,
      "..",
      "..",
      "dist",
      "mcp",
      `${name}.js`,
    );
    return existsSync(compiled)
      ? { command: process.execPath, args: [compiled] }
      : null;
  }
  const compiled = join(directory, `${name}.js`);
  return existsSync(compiled)
    ? { command: process.execPath, args: [compiled] }
    : null;
}

/** Locates the stdio bridge that ships with this server build. */
export function resolveMcpBridge(
  moduleUrl: string = import.meta.url,
): McpBridgeCommand | null {
  return resolveMcpScript("stdio", moduleUrl);
}

/** Only a same-computer StreamerAI server may be written into host configs. */
export function isLoopbackBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

const TOKEN_PREFIX = "smcp";
export type McpTokenOwner = McpHostId | "manual";
type TokenOwner = McpTokenOwner;
function tokenKey(profileId: string, owner: TokenOwner) {
  return `mcp-host-token:${profileId}:${owner}`;
}
function digest(value: string) {
  return createHash("sha256").update(value).digest();
}
/** When a host credential was issued and when its bridge last started. */
export interface McpConnection {
  readonly issuedAt: string;
  /** Set once the host has loaded the bridge with this credential. */
  readonly seenAt?: string;
}
type TokenRecord = McpConnection & { readonly digest: string };
function parseTokenRecord(stored: string | undefined): TokenRecord | null {
  if (!stored) return null;
  if (/^[a-f0-9]{64}$/.test(stored)) return { digest: stored, issuedAt: "" };
  try {
    const value = record(JSON.parse(stored));
    if (
      typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.digest)
    )
      return null;
    return {
      digest: value.digest,
      issuedAt: typeof value.issuedAt === "string" ? value.issuedAt : "",
      ...(typeof value.seenAt === "string" ? { seenAt: value.seenAt } : {}),
    };
  } catch {
    return null;
  }
}
const SEEN_WRITE_INTERVAL_MS = 60_000;

/**
 * Per-profile, per-host credentials for the external stdio bridge. Only the
 * SHA-256 digest is stored; the token itself lives in the host configuration.
 */
export class McpAccessTokens {
  constructor(
    private readonly secrets: SecretStore,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async issue(profileId: string, owner: TokenOwner): Promise<string> {
    const token = [
      TOKEN_PREFIX,
      owner,
      Buffer.from(profileId).toString("base64url"),
      randomBytes(32).toString("base64url"),
    ].join(".");
    const stored: TokenRecord = {
      digest: digest(token).toString("hex"),
      issuedAt: this.now().toISOString(),
    };
    await this.secrets.set(tokenKey(profileId, owner), JSON.stringify(stored));
    return token;
  }
  /** Connection details for a host credential, without the credential. */
  async describe(
    profileId: string,
    owner: TokenOwner,
  ): Promise<McpConnection | null> {
    const stored = parseTokenRecord(
      await this.secrets.get(tokenKey(profileId, owner)),
    );
    if (!stored) return null;
    return {
      issuedAt: stored.issuedAt,
      ...(stored.seenAt ? { seenAt: stored.seenAt } : {}),
    };
  }
  /** Records that a host started the bridge, so setup can stop asking for a restart. */
  async markSeen(token: string): Promise<McpConnection | null> {
    const access = await this.verify(token);
    if (!access) return null;
    const key = tokenKey(access.profileId, access.owner);
    const stored = parseTokenRecord(await this.secrets.get(key));
    if (!stored) return null;
    const now = this.now();
    if (
      stored.seenAt &&
      now.getTime() - Date.parse(stored.seenAt) < SEEN_WRITE_INTERVAL_MS
    )
      return { issuedAt: stored.issuedAt, seenAt: stored.seenAt };
    const updated: TokenRecord = { ...stored, seenAt: now.toISOString() };
    await this.secrets.set(key, JSON.stringify(updated));
    return { issuedAt: updated.issuedAt, seenAt: updated.seenAt };
  }
  async verify(
    token: string,
  ): Promise<{ profileId: string; owner: TokenOwner } | null> {
    if (token.length > 400) return null;
    const [prefix, owner, encodedProfile, secret, extra] = token.split(".");
    if (
      prefix !== TOKEN_PREFIX ||
      extra !== undefined ||
      !secret ||
      !encodedProfile ||
      !(owner === "manual" || isMcpHostId(owner))
    )
      return null;
    const profileId = Buffer.from(encodedProfile, "base64url").toString();
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(profileId)) return null;
    const stored = parseTokenRecord(
      await this.secrets.get(tokenKey(profileId, owner)),
    );
    if (!stored) return null;
    return timingSafeEqual(Buffer.from(stored.digest, "hex"), digest(token))
      ? { profileId, owner }
      : null;
  }
  async matches(token: string, profileId: string, owner: TokenOwner) {
    const access = await this.verify(token);
    return access?.profileId === profileId && access.owner === owner;
  }
  revoke(profileId: string, owner: TokenOwner): Promise<void> {
    return this.secrets.delete(tokenKey(profileId, owner));
  }
}

type Json = Record<string, unknown>;
function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function writeAtomically(
  path: string,
  content: string,
  previous: string | null,
) {
  mkdirSync(dirname(path), { recursive: true });
  if (previous !== null) writeFileSync(`${path}.streamerai.bak`, previous);
  const temporary = `${path}.streamerai-${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}
function parseJsonConfig(text: string | null, path: string): Json {
  if (text === null || !text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Json;
  } catch {
    // Reported below.
  }
  throw new McpHostConfigError(
    `${path} is not valid JSON. Fix or remove it, then try again.`,
  );
}

const TOML_SECTION =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:"streamer-ai"|streamer-ai)\s*(?:\.\s*([A-Za-z0-9_"-]+)\s*)?\]\s*(?:#.*)?$/;
const TOML_HEADER = /^\s*\[/;

/** Removes every StreamerAI table from a Codex config.toml, preserving the rest. */
export function removeCodexEntry(text: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (TOML_HEADER.test(line)) skipping = TOML_SECTION.test(line);
    if (!skipping) kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
function tomlString(value: string) {
  return JSON.stringify(value);
}
export function codexEntry(entry: BridgeEntry): string {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    "",
    `[mcp_servers.${MCP_SERVER_NAME}.env]`,
    ...Object.entries(entry.env).map(
      ([key, value]) => `${key} = ${tomlString(value)}`,
    ),
  ].join("\n");
}
/** Reads the StreamerAI table written by {@link codexEntry}. */
export function readCodexEntry(text: string): BridgeEntry | null {
  let section: "main" | "env" | null = null;
  let found = false;
  const entry: BridgeEntry = { command: "", args: [], env: {} };
  for (const line of text.split(/\r?\n/)) {
    if (TOML_HEADER.test(line)) {
      const match = TOML_SECTION.exec(line);
      section = match ? (match[1] === "env" ? "env" : "main") : null;
      if (match) found = true;
      continue;
    }
    if (!section) continue;
    const assignment = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!assignment) continue;
    let value: unknown;
    try {
      value = JSON.parse(assignment[2]!);
    } catch {
      continue;
    }
    if (section === "env" && typeof value === "string")
      entry.env[assignment[1]!] = value;
    else if (assignment[1] === "command" && typeof value === "string")
      entry.command = value;
    else if (
      assignment[1] === "args" &&
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    )
      entry.args = value;
  }
  return found ? entry : null;
}

export class McpHostConfigError extends Error {}
export type McpBridgeEntry = BridgeEntry;

function hostDefinition(id: McpHostId) {
  return HOSTS.find((host) => host.id === id)!;
}
export function mcpHostName(id: McpHostId): string {
  return hostDefinition(id).name;
}
function isDetected(host: HostDefinition, environment: McpHostEnvironment) {
  return (
    host.markers(environment).some((path) => existsSync(path)) ||
    host.executables.some((name) => findExecutable(name, environment))
  );
}
/** Hosts installed or used by the account whose environment this is. */
export function detectMcpHosts(environment: McpHostEnvironment): McpHostId[] {
  return HOSTS.filter((host) => isDetected(host, environment)).map(
    (host) => host.id,
  );
}

export function mcpBridgeEntry(
  bridge: McpBridgeCommand,
  baseUrl: string,
  profileId: string,
  token: string,
): BridgeEntry {
  return {
    command: bridge.command,
    args: [...bridge.args],
    env: {
      STREAMERAI_MCP_BASE_URL: baseUrl,
      STREAMERAI_MCP_PROFILE_ID: profileId,
      STREAMERAI_MCP_TOKEN: token,
    },
  };
}

function readHostEntry(host: HostDefinition, path: string): BridgeEntry | null {
  const text = readText(path);
  if (text === null) return null;
  if (host.format === "toml") return readCodexEntry(text);
  const entry = record(
    record(parseJsonConfig(text, path).mcpServers)[MCP_SERVER_NAME],
  );
  if (!Object.keys(entry).length) return null;
  const env = record(entry.env);
  return {
    command: typeof entry.command === "string" ? entry.command : "",
    args: Array.isArray(entry.args)
      ? entry.args.filter((item): item is string => typeof item === "string")
      : [],
    env: Object.fromEntries(
      Object.entries(env).filter(
        (item): item is [string, string] => typeof item[1] === "string",
      ),
    ),
  };
}
function readConfigText(path: string) {
  try {
    return readText(path);
  } catch {
    throw new McpHostConfigError(
      `StreamerAI could not read ${path}. Check its permissions.`,
    );
  }
}

export interface McpHostWrite {
  readonly path: string;
  /** Writes the StreamerAI entry atomically, keeping a backup of the old file. */
  commit(entry: BridgeEntry): void;
}
/**
 * Validates a host configuration before any credential is issued, so a
 * broken file is never half-written.
 */
export function prepareMcpHostWrite(
  environment: McpHostEnvironment,
  id: McpHostId,
): McpHostWrite {
  const host = hostDefinition(id);
  const path = host.configPath(environment);
  const previous = readConfigText(path);
  const parsed =
    host.format === "json" ? parseJsonConfig(previous, path) : null;
  return {
    path,
    commit(entry) {
      let content: string;
      if (host.format === "toml") {
        const rest = removeCodexEntry(previous ?? "");
        content = `${rest ? `${rest}\n\n` : ""}${codexEntry(entry)}\n`;
      } else {
        const config = { ...parsed! };
        config.mcpServers = {
          ...record(config.mcpServers),
          [MCP_SERVER_NAME]: host.jsonEntry ? host.jsonEntry(entry) : entry,
        };
        content = `${JSON.stringify(config, null, 2)}\n`;
      }
      try {
        writeAtomically(path, content, previous);
      } catch {
        throw new McpHostConfigError(
          `StreamerAI could not write ${path}. Check that the file is not read-only.`,
        );
      }
    },
  };
}

/** Removes the StreamerAI entry only when it belongs to the given profile. */
export function removeMcpHostEntry(
  environment: McpHostEnvironment,
  id: McpHostId,
  profileId: string,
): void {
  const host = hostDefinition(id);
  const path = host.configPath(environment);
  const previous = readConfigText(path);
  if (previous === null) return;
  const existing = readHostEntry(host, path);
  if (!existing || existing.env.STREAMERAI_MCP_PROFILE_ID !== profileId) return;
  let content: string;
  if (host.format === "toml") {
    const rest = removeCodexEntry(previous);
    content = rest ? `${rest}\n` : "";
  } else {
    const config = parseJsonConfig(previous, path);
    const servers = record(config.mcpServers);
    delete servers[MCP_SERVER_NAME];
    config.mcpServers = servers;
    content = `${JSON.stringify(config, null, 2)}\n`;
  }
  writeAtomically(path, content, previous);
}

export interface McpHostInstallerOptions {
  readonly tokens: McpAccessTokens;
  readonly baseUrl: string;
  readonly bridge: () => McpBridgeCommand | null;
  /** The user-side helper used when the server runs as a service account. */
  readonly connector?: () => McpBridgeCommand | null;
  readonly environment?: () => McpHostEnvironment;
}

export class McpHostInstaller {
  constructor(private readonly options: McpHostInstallerOptions) {}
  get baseUrl(): string {
    return this.options.baseUrl;
  }
  private environment() {
    return (this.options.environment ?? currentMcpHostEnvironment)();
  }
  private async hostStatus(
    host: HostDefinition,
    profileId: string,
    environment: McpHostEnvironment,
    bridge: McpBridgeCommand | null,
  ): Promise<McpHostStatus> {
    const configPath = host.configPath(environment);
    const base = {
      id: host.id,
      name: host.name,
      configPath,
      restartHint: host.restartHint,
    };
    let entry: BridgeEntry | null;
    try {
      entry = readHostEntry(host, configPath);
    } catch (error) {
      return {
        ...base,
        state: "outdated",
        message:
          error instanceof McpHostConfigError
            ? error.message
            : "The host configuration could not be read.",
      };
    }
    if (!entry)
      return {
        ...base,
        state: isDetected(host, environment) ? "available" : "not-detected",
      };
    if (entry.env.STREAMERAI_MCP_PROFILE_ID !== profileId)
      return { ...base, state: "other-profile" };
    const current =
      !!bridge &&
      entry.command === bridge.command &&
      JSON.stringify(entry.args) === JSON.stringify(bridge.args) &&
      entry.env.STREAMERAI_MCP_BASE_URL === this.options.baseUrl &&
      typeof entry.env.STREAMERAI_MCP_TOKEN === "string" &&
      (await this.options.tokens.matches(
        entry.env.STREAMERAI_MCP_TOKEN,
        profileId,
        host.id,
      ));
    if (!current) return { ...base, state: "outdated" };
    const connection = await this.options.tokens.describe(profileId, host.id);
    return {
      ...base,
      state: "installed",
      ...(connection ? { connection } : {}),
    };
  }
  /**
   * A service account cannot read the user's host files. Its view comes from
   * the credentials the user-side connector obtained for this profile.
   */
  private async connectorStatus(
    host: HostDefinition,
    profileId: string,
    environment: McpHostEnvironment,
  ): Promise<McpHostStatus> {
    const display: McpHostEnvironment = {
      platform: environment.platform,
      home: "~",
      env: {},
      serviceAccount: true,
    };
    const connection = await this.options.tokens.describe(profileId, host.id);
    return {
      id: host.id,
      name: host.name,
      configPath: host.configPath(display),
      restartHint: host.restartHint,
      state: connection ? "installed" : "not-detected",
      ...(connection ? { connection } : {}),
    };
  }
  async overview(profileId: string): Promise<McpHostsOverview> {
    const environment = this.environment();
    const bridge = this.options.bridge();
    return {
      bridge: bridge
        ? { available: true }
        : {
            available: false,
            message:
              "The MCP bridge is missing from this server build. Build the server (pnpm --filter @streamer-ai/server build) and try again.",
          },
      serviceAccount: environment.serviceAccount,
      connector: { available: !!this.options.connector?.() },
      hosts: await Promise.all(
        HOSTS.map((host) =>
          environment.serviceAccount
            ? this.connectorStatus(host, profileId, environment)
            : this.hostStatus(host, profileId, environment, bridge),
        ),
      ),
    };
  }
  private requireBridge() {
    const bridge = this.options.bridge();
    if (!bridge)
      throw new McpHostConfigError(
        "The MCP bridge is missing from this server build.",
      );
    return bridge;
  }
  async install(profileId: string, id: McpHostId): Promise<void> {
    const environment = this.environment();
    if (environment.serviceAccount)
      throw new McpHostConfigError(
        "StreamerAI runs as a background service. Use Connect agents on this computer instead.",
      );
    const bridge = this.requireBridge();
    const write = prepareMcpHostWrite(environment, id);
    const token = await this.options.tokens.issue(profileId, id);
    try {
      write.commit(
        mcpBridgeEntry(bridge, this.options.baseUrl, profileId, token),
      );
    } catch (error) {
      await this.options.tokens.revoke(profileId, id);
      throw error;
    }
  }
  /**
   * Removes this profile's entry from the host and revokes its credential.
   * As a service account only the credential can be revoked.
   */
  async remove(profileId: string, id: McpHostId): Promise<void> {
    const environment = this.environment();
    if (!environment.serviceAccount)
      removeMcpHostEntry(environment, id, profileId);
    await this.options.tokens.revoke(profileId, id);
  }
  /** Issues a fresh manual-setup credential and the matching host snippets. */
  async manual(profileId: string): Promise<McpManualSetup> {
    const bridge = this.requireBridge();
    const token = await this.options.tokens.issue(profileId, "manual");
    const entry = mcpBridgeEntry(
      bridge,
      this.options.baseUrl,
      profileId,
      token,
    );
    const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
    const envFlags = Object.entries(entry.env)
      .map(([key, value]) => `--env ${key}=${value}`)
      .join(" ");
    const command = [entry.command, ...entry.args].map(quote).join(" ");
    return {
      command: entry.command,
      args: entry.args,
      env: entry.env,
      claudeCommand: `claude mcp add ${MCP_SERVER_NAME} --scope user ${envFlags} -- ${command}`,
      codexCommand: `codex mcp add ${MCP_SERVER_NAME} ${envFlags} -- ${command}`,
      json: JSON.stringify(
        { mcpServers: { [MCP_SERVER_NAME]: entry } },
        null,
        2,
      ),
    };
  }
}
