import {
  effectiveEffort,
  type AgentModel,
  type ReasoningEffort,
} from "./agent-model-catalog.js";

export type OllamaThinkingValue = boolean | "low" | "medium" | "high";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Keep the picker and /api/chat on the same model-reported controls. */
export function ollamaThinkingValues(details: unknown): OllamaThinkingValue[] {
  const info = record(details);
  const thinking = record(info?.thinking);
  if (Array.isArray(thinking?.values)) {
    return thinking.values.filter(
      (value): value is OllamaThinkingValue =>
        typeof value === "boolean" ||
        value === "low" ||
        value === "medium" ||
        value === "high",
    );
  }
  // Older Ollama versions advertise thinking without the newer values metadata.
  return Array.isArray(info?.capabilities) &&
    info.capabilities.includes("thinking")
    ? [false, true]
    : [];
}

export function ollamaReasoningEfforts(
  values: readonly OllamaThinkingValue[],
): ReasoningEffort[] {
  const efforts: ReasoningEffort[] = [
    ...(values.includes(false) ? (["none"] as const) : []),
    ...(["low", "medium", "high"] as const).filter((effort) =>
      values.includes(effort),
    ),
  ];
  if (values.includes(true) && !efforts.includes("high")) efforts.push("high");
  // No affirmative capability evidence: do not invent selectable thinking modes.
  return efforts.length ? efforts : ["none"];
}

export function effectiveOllamaEffort(
  requested: ReasoningEffort,
  model: AgentModel,
): ReasoningEffort {
  // A saved generic Light preference must still enable an on/off thinking model.
  if (requested === "low") {
    return (
      (["low", "medium", "high", "none"] as const).find((effort) =>
        model.reasoningEfforts.includes(effort),
      ) ?? "none"
    );
  }
  return effectiveEffort(requested, model);
}

export function ollamaThinkingValue(
  values: readonly OllamaThinkingValue[],
  requested: ReasoningEffort,
): OllamaThinkingValue | null {
  // Missing metadata cannot establish whether a model permits disabling thinking.
  // Let Ollama use its own default rather than send an unsupported value.
  if (!values.length) return null;
  const effort = effectiveOllamaEffort(requested, {
    id: "",
    label: "",
    reasoningEfforts: ollamaReasoningEfforts(values),
  });
  if (effort === "none") return false;
  return values.includes(effort) ? effort : true;
}
