import type { RuntimeConfig } from "../runtime-config.js";

export type AgentName = RuntimeConfig["agent"]["provider"];
export type ReasoningEffort = "none" | "low" | "medium" | "high";
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
];

export interface AgentModel {
  id: string;
  label: string;
  reasoningEfforts: ReasoningEffort[];
}

export interface AgentModelCatalog {
  provider: AgentName;
  models: AgentModel[];
  recommendedModel: string | null;
  source: "provider" | "local" | "fallback";
  status: "available" | "unverified" | "unavailable";
  message: string;
}

// These are documented lightweight defaults. A live model list takes priority
// because access and available model IDs vary by account and over time.
export const FALLBACK_MODEL: Partial<Record<AgentName, string>> = {
  openai: "gpt-6-luna",
  anthropic: "claude-haiku-5-5",
  gemini: "gemini-3.1-flash-lite",
  grok: "grok-4.3",
  kimi: "kimi-k2.6",
  deepseek: "deepseek-flash",
  claude: "haiku",
};

export function modelReasoningEfforts(
  provider: AgentName,
  model: string,
): ReasoningEffort[] {
  const id = model.toLowerCase();
  if (provider === "ollama") return ["none"];
  if (provider === "codex") return ["low", "medium", "high"];
  if (provider === "claude") return ["low", "medium", "high"];
  if (provider === "anthropic")
    return id.includes("haiku-5-5")
      ? [...REASONING_EFFORTS]
      : ["low", "medium", "high"];
  if (provider === "openai") {
    if (id.includes("astra") || id.includes("6.1-sol"))
      return ["low", "medium", "high"];
    if (id.startsWith("gpt-6") || id.startsWith("gpt-5"))
      return [...REASONING_EFFORTS];
    return ["none"];
  }
  if (provider === "gemini")
    return id.includes("flash-lite")
      ? [...REASONING_EFFORTS]
      : ["low", "medium", "high"];
  if (provider === "grok")
    return id.startsWith("grok-4.3")
      ? [...REASONING_EFFORTS]
      : ["low", "medium", "high"];
  if (provider === "kimi")
    return id.includes("k2.6") ? ["none", "high"] : ["low", "medium", "high"];
  if (provider === "deepseek") return ["none", "low", "high"];
  return ["low", "medium", "high"];
}

export function modelOption(
  provider: AgentName,
  id: string,
  label = id,
  efforts?: readonly ReasoningEffort[],
): AgentModel {
  return {
    id,
    label,
    reasoningEfforts: efforts
      ? [...efforts]
      : modelReasoningEfforts(provider, id),
  };
}

function modelRank(provider: AgentName, id: string): number {
  const lower = id.toLowerCase();
  if (id === FALLBACK_MODEL[provider]) return 0;
  if (provider === "codex" && lower.includes("luna")) return 1;
  if (provider === "ollama") {
    const match = /(?:^|[:/_-])(\d+(?:\.\d+)?)b(?:$|[-_/.])/.exec(lower);
    return match ? Number(match[1]) : 100;
  }
  if (/flash-lite|haiku|luna|mini|flash|fast/.test(lower)) return 2;
  if (/pro|astra|max|reasoner|opus/.test(lower)) return 20;
  return 10;
}

export function recommendedModel(
  provider: AgentName,
  models: readonly AgentModel[],
  effort: ReasoningEffort = "low",
): string | null {
  const candidates = models.filter((item) =>
    item.reasoningEfforts.includes(effort),
  );
  const sorted = [...(candidates.length ? candidates : models)].sort(
    (a, b) =>
      modelRank(provider, a.id) - modelRank(provider, b.id) ||
      a.id.localeCompare(b.id),
  );
  return sorted[0]?.id ?? null;
}

export function fallbackCatalog(
  provider: AgentName,
  message: string,
): AgentModelCatalog {
  const id = FALLBACK_MODEL[provider];
  const models = id ? [modelOption(provider, id)] : [];
  return {
    provider,
    models,
    recommendedModel: id ?? null,
    source: "fallback",
    status: "unverified",
    message,
  };
}

/** Search instruction size follows model capacity, independently of thinking effort. */
export function discoveryTierForAgent(
  provider: AgentName,
  chosenModel?: string,
): "balanced" | "extended" {
  const model = (chosenModel ?? FALLBACK_MODEL[provider] ?? "").toLowerCase();
  return /astra|opus|sonnet|fable|mythos|deepseek-v4-pro|kimi-k3|gpt-6(?:\.1)?-sol/.test(
    model,
  )
    ? "extended"
    : "balanced";
}

export function effectiveEffort(
  requested: ReasoningEffort,
  model: AgentModel,
): ReasoningEffort {
  const alternatives: Record<ReasoningEffort, ReasoningEffort[]> = {
    none: ["none", "low", "medium", "high"],
    low: ["low", "medium", "none", "high"],
    medium: ["medium", "high", "low", "none"],
    high: ["high", "medium", "low", "none"],
  };
  return (
    alternatives[requested].find((effort) =>
      model.reasoningEfforts.includes(effort),
    ) ?? "low"
  );
}
