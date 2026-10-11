import type { RuntimeConfig } from "../runtime-config.js";

export type OllamaHealthState =
  "READY" | "DEGRADED" | "MODEL_MISSING" | "INCOMPATIBLE" | "OOM" | "OFFLINE";

export interface InferenceFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface InferenceFetchOptions {
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
  readonly redirect?: "manual";
}

export type InferenceFetch = (
  url: string,
  options: InferenceFetchOptions,
) => Promise<InferenceFetchResponse>;

export interface OllamaPreflightResult {
  readonly ok: boolean;
  readonly state: OllamaHealthState;
  readonly runtime: "Ollama";
  readonly model: string;
  readonly messageCode: string;
  readonly message: string;
  readonly checkedAt: string;
  readonly checks: {
    version: boolean;
    model: boolean;
    metadata: boolean;
    structuredOutput: boolean;
    tools: boolean;
    residency: boolean;
  };
  readonly details?: {
    readonly version: string;
    readonly digest: string;
    readonly parameterSize: string;
    readonly quantization: string;
    readonly loadedVramBytes: number | null;
    readonly modelSizeBytes: number | null;
    readonly contextLength: number | null;
  };
}

interface PreflightFailureOptions {
  state: Exclude<OllamaHealthState, "READY" | "DEGRADED">;
  messageCode: string;
  message: string;
}

class PreflightFailure extends Error {
  readonly state: PreflightFailureOptions["state"];
  readonly messageCode: string;

  constructor(options: PreflightFailureOptions) {
    super(options.message);
    this.name = "PreflightFailure";
    this.state = options.state;
    this.messageCode = options.messageCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function versionParts(value: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = versionParts(actual);
  const minimumParts = versionParts(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] !== minimumParts[index]) {
      return actualParts[index]! > minimumParts[index]!;
    }
  }
  return true;
}

function installedModel(
  body: unknown,
  configuredModel: string,
): { name: string; digest: string } | undefined {
  if (!isRecord(body) || !Array.isArray(body.models)) return undefined;
  for (const candidate of body.models) {
    if (!isRecord(candidate)) continue;
    const name = stringValue(candidate.name ?? candidate.model);
    if (name !== configuredModel) continue;
    return { name, digest: stringValue(candidate.digest) ?? "unknown" };
  }
  return undefined;
}

function failedChecks(): OllamaPreflightResult["checks"] {
  return {
    version: false,
    model: false,
    metadata: false,
    structuredOutput: false,
    tools: false,
    residency: false,
  };
}

function isOutOfMemory(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /out of memory|insufficient memory|cuda.*alloc|gpu memory/i.test(
    message,
  );
}

async function requestJson(
  fetch: InferenceFetch,
  url: string,
  timeoutMs: number,
  body?: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      redirect: "manual",
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed with HTTP ${response.status}.`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function metadataFromShow(body: unknown): {
  parameterSize: string;
  quantization: string;
} {
  if (!isRecord(body)) {
    throw new PreflightFailure({
      state: "INCOMPATIBLE",
      messageCode: "INVALID_MODEL_METADATA",
      message: "Ollama returned invalid model metadata.",
    });
  }
  const details = isRecord(body.details) ? body.details : {};
  const parameterSize = stringValue(details.parameter_size) ?? "unknown";
  const quantization = stringValue(details.quantization_level) ?? "unknown";
  const family = (stringValue(details.family) ?? "").toLowerCase();
  const license = (stringValue(body.license) ?? "").toLowerCase();
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.filter(
        (item): item is string => typeof item === "string",
      )
    : [];

  if (
    !family.includes("qwen") ||
    quantization.toUpperCase() !== "Q4_K_M" ||
    !license.includes("apache") ||
    !license.includes("2.0") ||
    !capabilities.includes("completion") ||
    !capabilities.includes("tools")
  ) {
    throw new PreflightFailure({
      state: "INCOMPATIBLE",
      messageCode: "MODEL_REQUIREMENTS_NOT_MET",
      message:
        "The configured model does not match the approved family, quantization, license, or capabilities.",
    });
  }
  return { parameterSize, quantization };
}

function validateStructuredCanary(body: unknown): void {
  if (!isRecord(body) || typeof body.response !== "string") {
    throw new PreflightFailure({
      state: "INCOMPATIBLE",
      messageCode: "STRUCTURED_OUTPUT_FAILED",
      message: "The model did not return a structured canary response.",
    });
  }
  try {
    const parsed: unknown = JSON.parse(body.response);
    if (
      !isRecord(parsed) ||
      parsed.ready !== true ||
      parsed.language !== "cs"
    ) {
      throw new Error("Unexpected canary value");
    }
  } catch {
    throw new PreflightFailure({
      state: "INCOMPATIBLE",
      messageCode: "STRUCTURED_OUTPUT_FAILED",
      message: "The model failed strict structured-output validation.",
    });
  }
}

function validateToolCanary(body: unknown): void {
  if (!isRecord(body) || !isRecord(body.message)) {
    throw new PreflightFailure({
      state: "INCOMPATIBLE",
      messageCode: "TOOL_CANARY_FAILED",
      message: "The model did not return a tool call.",
    });
  }
  const calls = body.message.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1 || !isRecord(calls[0])) {
    throw new PreflightFailure({
      state: "INCOMPATIBLE",
      messageCode: "TOOL_CANARY_FAILED",
      message: "The model failed the bounded tool-call canary.",
    });
  }
  const fn = isRecord(calls[0].function) ? calls[0].function : {};
  const args = isRecord(fn.arguments) ? fn.arguments : {};
  if (fn.name !== "echo" || args.value !== "streamer-ai-canary") {
    throw new PreflightFailure({
      state: "INCOMPATIBLE",
      messageCode: "TOOL_CANARY_FAILED",
      message: "The model returned an invalid tool name or arguments.",
    });
  }
}

function processDetails(
  body: unknown,
  configuredModel: string,
): {
  loadedVramBytes: number | null;
  modelSizeBytes: number | null;
  contextLength: number | null;
} {
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new PreflightFailure({
      state: "INCOMPATIBLE",
      messageCode: "RESIDENCY_CHECK_FAILED",
      message: "Ollama did not report the loaded model.",
    });
  }
  const loaded = body.models.find(
    (item) =>
      isRecord(item) &&
      stringValue(item.name ?? item.model) === configuredModel,
  );
  if (!isRecord(loaded)) {
    throw new PreflightFailure({
      state: "INCOMPATIBLE",
      messageCode: "RESIDENCY_CHECK_FAILED",
      message: "The configured model was not resident after warm-up.",
    });
  }
  return {
    loadedVramBytes: numberValue(loaded.size_vram),
    modelSizeBytes: numberValue(loaded.size),
    contextLength: numberValue(loaded.context_length),
  };
}

/** Run a bounded, side-effect-free compatibility check against Ollama. */
export async function preflightOllama(options: {
  fetch: InferenceFetch;
  config: RuntimeConfig["inference"];
  now: () => Date;
}): Promise<OllamaPreflightResult> {
  const { fetch, config, now } = options;
  const checks = failedChecks();
  let version = "unknown";
  let digest = "unknown";
  let parameterSize = "unknown";
  let quantization = "unknown";

  try {
    const versionBody = await requestJson(
      fetch,
      `${config.baseUrl}/api/version`,
      config.timeoutMs,
    );
    version =
      isRecord(versionBody) && stringValue(versionBody.version)
        ? stringValue(versionBody.version)!
        : "unknown";
    if (!versionAtLeast(version, config.minimumVersion)) {
      throw new PreflightFailure({
        state: "INCOMPATIBLE",
        messageCode: "RUNTIME_VERSION_UNSUPPORTED",
        message: `Ollama ${config.minimumVersion} or newer is required.`,
      });
    }
    checks.version = true;

    const tagsBody = await requestJson(
      fetch,
      `${config.baseUrl}/api/tags`,
      config.timeoutMs,
    );
    const installed = installedModel(tagsBody, config.model);
    if (!installed) {
      throw new PreflightFailure({
        state: "MODEL_MISSING",
        messageCode: "MODEL_NOT_INSTALLED",
        message: `Install the approved model '${config.model}' to enable local AI.`,
      });
    }
    digest = installed.digest;
    checks.model = true;

    const showBody = await requestJson(
      fetch,
      `${config.baseUrl}/api/show`,
      config.timeoutMs,
      { model: config.model, verbose: false },
    );
    ({ parameterSize, quantization } = metadataFromShow(showBody));
    checks.metadata = true;

    const structuredBody = await requestJson(
      fetch,
      `${config.baseUrl}/api/generate`,
      config.timeoutMs,
      {
        model: config.model,
        prompt: 'Return exactly this object: {"ready":true,"language":"cs"}.',
        stream: false,
        think: false,
        keep_alive: "2m",
        format: {
          type: "object",
          additionalProperties: false,
          required: ["ready", "language"],
          properties: {
            ready: { type: "boolean", const: true },
            language: { type: "string", const: "cs" },
          },
        },
        options: {
          num_ctx: config.contextTokens,
          num_predict: config.maxOutputTokens,
          temperature: 0,
        },
      },
    );
    validateStructuredCanary(structuredBody);
    checks.structuredOutput = true;

    const toolBody = await requestJson(
      fetch,
      `${config.baseUrl}/api/chat`,
      config.timeoutMs,
      {
        model: config.model,
        stream: false,
        think: false,
        keep_alive: "2m",
        messages: [
          {
            role: "user",
            content:
              "Call echo once with value streamer-ai-canary. Do not answer in text.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "echo",
              description: "Return a canary value without side effects.",
              parameters: {
                type: "object",
                additionalProperties: false,
                required: ["value"],
                properties: { value: { type: "string" } },
              },
            },
          },
        ],
        options: {
          num_ctx: config.contextTokens,
          num_predict: config.maxOutputTokens,
          temperature: 0,
        },
      },
    );
    validateToolCanary(toolBody);
    checks.tools = true;

    const psBody = await requestJson(
      fetch,
      `${config.baseUrl}/api/ps`,
      config.timeoutMs,
    );
    const residency = processDetails(psBody, config.model);
    checks.residency = true;
    const degraded =
      residency.loadedVramBytes !== null &&
      residency.modelSizeBytes !== null &&
      residency.modelSizeBytes > 0 &&
      residency.loadedVramBytes / residency.modelSizeBytes < 0.5;

    return {
      ok: true,
      state: degraded ? "DEGRADED" : "READY",
      runtime: "Ollama",
      model: config.model,
      messageCode: degraded ? "CPU_OFFLOAD_HIGH" : "READY",
      message: degraded
        ? "Local AI passed validation but most model data is offloaded from the GPU."
        : "Local AI passed runtime, model, schema, tool, and residency checks.",
      checkedAt: now().toISOString(),
      checks,
      details: {
        version,
        digest,
        parameterSize,
        quantization,
        ...residency,
      },
    };
  } catch (error) {
    const failure =
      error instanceof PreflightFailure
        ? error
        : isOutOfMemory(error)
          ? new PreflightFailure({
              state: "OOM",
              messageCode: "OUT_OF_MEMORY",
              message:
                "Ollama could not load or run the configured model with available memory.",
            })
          : new PreflightFailure({
              state: "OFFLINE",
              messageCode: "RUNTIME_UNREACHABLE",
              message:
                "Ollama did not complete the bounded preflight. Check that it is running and reachable.",
            });
    return {
      ok: false,
      state: failure.state,
      runtime: "Ollama",
      model: config.model,
      messageCode: failure.messageCode,
      message: failure.message,
      checkedAt: now().toISOString(),
      checks,
    };
  }
}
