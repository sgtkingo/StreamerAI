import { loadEnvFile } from "node:process";

const DEFAULT_SERVER_PORT = 4400;
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "qwen3.5:4b";

export interface RuntimeConfig {
  readonly environment: string;
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly dataDir: string;
  };
  readonly secrets: {
    readonly backend: "memory" | "encrypted-file";
    readonly vaultFile: string;
    readonly keyFile: string | null;
  };
  readonly inference: {
    readonly provider: "ollama";
    readonly baseUrl: string;
    readonly model: string;
    readonly minimumVersion: string;
    readonly contextTokens: number;
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
    readonly discoveryTier?: "compact" | "balanced" | "extended";
    readonly reasoningEffort?: "none" | "low" | "medium" | "high";
  };
  readonly agent: {
    readonly mode: "api" | "local" | "mcp" | "disabled";
    readonly provider:
      | "ollama"
      | "custom"
      | "codex"
      | "claude"
      | "openai"
      | "anthropic"
      | "gemini"
      | "grok"
      | "kimi"
      | "deepseek";
    readonly model?: string;
    readonly reasoningEffort?: "none" | "low" | "medium" | "high";
  };
}

type Environment = Readonly<Record<string, string | undefined>>;

function integerSetting(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function nonEmptySetting(
  value: string | undefined,
  fallback: string,
  name: string,
): string {
  const parsed = value?.trim() || fallback;
  if (parsed.length > 512) throw new Error(`${name} is too long.`);
  return parsed;
}

function ollamaBaseUrl(value: string | undefined): string {
  const raw = nonEmptySetting(
    value,
    DEFAULT_OLLAMA_BASE_URL,
    "INFERENCE_BASE_URL",
  );
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("INFERENCE_BASE_URL must be an absolute HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("INFERENCE_BASE_URL must use HTTP or HTTPS.");
  }
  const insecureAllowedHosts = new Set([
    "127.0.0.1",
    "localhost",
    "::1",
    "ollama",
    "host.docker.internal",
  ]);
  if (
    parsed.protocol === "http:" &&
    !insecureAllowedHosts.has(parsed.hostname)
  ) {
    throw new Error(
      "Remote INFERENCE_BASE_URL endpoints must use HTTPS; plain HTTP is limited to local or private runtime bridge names.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "INFERENCE_BASE_URL must not contain credentials, a query, or a fragment.",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString().replace(/\/$/, "");
}

/** Parse all process settings once, before composing runtime dependencies. */
export function readRuntimeConfig(
  env: Environment = process.env,
): RuntimeConfig {
  const provider = nonEmptySetting(
    env.INFERENCE_PROVIDER,
    "ollama",
    "INFERENCE_PROVIDER",
  );
  if (provider !== "ollama") {
    throw new Error(
      `Unsupported INFERENCE_PROVIDER '${provider}'. This build supports 'ollama'.`,
    );
  }
  const secretBackend = nonEmptySetting(
    env.STREAMERAI_SECRET_BACKEND,
    "memory",
    "STREAMERAI_SECRET_BACKEND",
  );
  if (secretBackend !== "memory" && secretBackend !== "encrypted-file") {
    throw new Error(
      "STREAMERAI_SECRET_BACKEND must be 'memory' or 'encrypted-file'.",
    );
  }

  const dataDir = nonEmptySetting(
    env.STREAMERAI_DATA_DIR,
    "data",
    "STREAMERAI_DATA_DIR",
  );
  const agentMode = nonEmptySetting(
    env.STREAMERAI_AGENT_MODE,
    "api",
    "STREAMERAI_AGENT_MODE",
  );
  const agentProvider = nonEmptySetting(
    env.STREAMERAI_AGENT_PROVIDER,
    "ollama",
    "STREAMERAI_AGENT_PROVIDER",
  );
  if (!["api", "local", "mcp", "disabled"].includes(agentMode))
    throw new Error(
      "STREAMERAI_AGENT_MODE must be api, local, mcp, or disabled.",
    );
  if (
    ![
      "ollama",
      "custom",
      "codex",
      "claude",
      "openai",
      "anthropic",
      "gemini",
      "grok",
      "kimi",
      "deepseek",
    ].includes(agentProvider)
  )
    throw new Error("STREAMERAI_AGENT_PROVIDER is unsupported.");
  if (agentMode === "api" && ["codex", "claude"].includes(agentProvider))
    throw new Error("API mode requires an API provider.");
  if (agentMode === "local" && !["codex", "claude"].includes(agentProvider))
    throw new Error("Local agent mode requires codex or claude.");
  if (agentMode === "mcp" && agentProvider !== "ollama")
    throw new Error(
      "MCP mode does not select an inference provider; use ollama as the placeholder.",
    );
  const agentModel = env.STREAMERAI_AGENT_MODEL?.trim();
  if (agentModel && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(agentModel))
    throw new Error("STREAMERAI_AGENT_MODEL is invalid.");
  const reasoningEffort =
    env.STREAMERAI_AGENT_REASONING_EFFORT?.trim() || "low";
  if (!["none", "low", "medium", "high"].includes(reasoningEffort))
    throw new Error(
      "STREAMERAI_AGENT_REASONING_EFFORT must be none, low, medium, or high.",
    );

  return {
    environment: nonEmptySetting(env.NODE_ENV, "development", "NODE_ENV"),
    server: {
      host: nonEmptySetting(
        env.STREAMERAI_HOST ?? env.HOST,
        "127.0.0.1",
        "STREAMERAI_HOST",
      ),
      port: integerSetting(
        env.STREAMERAI_PORT ?? env.PORT,
        DEFAULT_SERVER_PORT,
        "STREAMERAI_PORT",
        1,
        65_535,
      ),
      dataDir,
    },
    secrets: {
      backend: secretBackend,
      vaultFile: nonEmptySetting(
        env.STREAMERAI_SECRET_VAULT_FILE,
        `${dataDir}/secrets.vault`,
        "STREAMERAI_SECRET_VAULT_FILE",
      ),
      keyFile: env.STREAMERAI_SECRET_KEY_FILE?.trim() || null,
    },
    inference: {
      provider,
      baseUrl: ollamaBaseUrl(env.INFERENCE_BASE_URL ?? env.OLLAMA_BASE_URL),
      model: nonEmptySetting(
        env.INFERENCE_MODEL ?? env.OLLAMA_MODEL,
        DEFAULT_OLLAMA_MODEL,
        "INFERENCE_MODEL",
      ),
      minimumVersion: nonEmptySetting(
        env.OLLAMA_MINIMUM_VERSION,
        "0.5.0",
        "OLLAMA_MINIMUM_VERSION",
      ),
      contextTokens: integerSetting(
        env.INFERENCE_CONTEXT_TOKENS,
        4_096,
        "INFERENCE_CONTEXT_TOKENS",
        512,
        131_072,
      ),
      maxOutputTokens: integerSetting(
        env.INFERENCE_MAX_OUTPUT_TOKENS,
        512,
        "INFERENCE_MAX_OUTPUT_TOKENS",
        32,
        4_096,
      ),
      timeoutMs: integerSetting(
        env.INFERENCE_TIMEOUT_MS,
        60_000,
        "INFERENCE_TIMEOUT_MS",
        500,
        120_000,
      ),
    },
    agent: {
      mode: agentMode as RuntimeConfig["agent"]["mode"],
      provider: agentProvider as RuntimeConfig["agent"]["provider"],
      ...(agentModel ? { model: agentModel } : {}),
      reasoningEffort: reasoningEffort as NonNullable<
        RuntimeConfig["agent"]["reasoningEffort"]
      >,
    },
  };
}

/**
 * Load non-secret local overrides. A missing file is normal; malformed or
 * unreadable files fail startup rather than silently running with surprises.
 */
export function loadLocalEnvironment(filename = ".env"): boolean {
  try {
    loadEnvFile(filename);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
