type DiscoveryPolicyTier = "compact" | "balanced" | "extended";

export interface DiscoveryInstructionPolicy {
  readonly tier: DiscoveryPolicyTier;
  readonly candidateCount: number;
  readonly temperature: number;
  readonly retryTemperature: number;
  readonly instruction: string;
  readonly displayInstruction: string;
  retryInstruction(previousTitles: readonly string[]): string;
}

export interface DiscoveryInstructionPolicyOptions {
  readonly tierOverride?: DiscoveryPolicyTier;
  readonly model: string;
  readonly parameterSize?: string | null;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly locale: "cs" | "en" | "de";
}

function parameterBillions(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([bm])(?:\b|$)/i.exec(value);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;
  return match[2]!.toLowerCase() === "m" ? count / 1_000 : count;
}

/**
 * Ollama reports total parameters during preflight. Some MoE tags also report
 * active parameters (for example, 30b-a3b); active size is the more useful
 * conservative proxy for how complex an instruction the model can follow.
 */
export function estimateActiveParameterBillions(
  model: string,
  parameterSize?: string | null,
): number | null {
  const activeTag = /(?:^|[-_:])a(\d+(?:\.\d+)?)b(?=$|[-_/.])/i.exec(model);
  if (activeTag) return Number(activeTag[1]);
  if (parameterSize) {
    const reported = parameterBillions(parameterSize);
    if (reported !== null) return reported;
  }
  const sizeTag = /(?:^|[:/_-])(\d+(?:\.\d+)?)\s*([bm])(?=$|[-_/.])/i.exec(
    model,
  );
  return sizeTag ? parameterBillions(`${sizeTag[1]}${sizeTag[2]}`) : null;
}

function policyTier(
  parameterCount: number | null,
  contextTokens: number,
): DiscoveryPolicyTier {
  if (
    contextTokens < 6_144 ||
    (parameterCount !== null && parameterCount < 7)
  ) {
    return "compact";
  }
  if (
    contextTokens >= 8_192 &&
    parameterCount !== null &&
    parameterCount >= 13
  ) {
    return "extended";
  }
  return "balanced";
}

function outputCandidateCapacity(maxOutputTokens: number): number {
  // A candidate with short reason plus JSON punctuation uses roughly 100 tokens.
  return Math.max(1, Math.min(6, Math.floor((maxOutputTokens - 80) / 100)));
}

/** Choose a bounded discovery prompt from the configured model and token limits. */
export function discoveryInstructionPolicy(
  options: DiscoveryInstructionPolicyOptions,
): DiscoveryInstructionPolicy {
  const parameters = estimateActiveParameterBillions(
    options.model,
    options.parameterSize,
  );
  const tier =
    options.tierOverride ?? policyTier(parameters, options.contextTokens);
  const desiredCount = tier === "compact" ? 3 : tier === "balanced" ? 4 : 6;
  const candidateCount = Math.min(
    desiredCount,
    outputCandidateCapacity(options.maxOutputTokens),
  );
  const temperature =
    tier === "compact" ? 0.2 : tier === "balanced" ? 0.28 : 0.35;
  const retryTemperature =
    tier === "compact" ? 0.3 : tier === "balanced" ? 0.4 : 0.5;
  const shared = [
    `Suggest ${candidateCount} distinct real films or series for this ${options.locale} user.`,
    "Match the WHOLE request: setting, themes, mood and exclusions, not only genre. Apply the latest correction first.",
    "Use exact title names; use null for uncertain years.",
    "For complete series, suggest concluded series; episode coverage is checked separately.",
    "Keep people empty unless the user explicitly names an actor, director or creator. If named, every suggestion must feature them.",
    "Include an exact quick-search hit for a named title.",
    "Avoid rejected or watched titles.",
    "Never claim availability or full episode coverage.",
    "Write acknowledgement and reasons in the user's language; return schema JSON.",
  ];
  const instruction =
    tier === "compact"
      ? shared.join(" ")
      : [
          ...shared,
          "Preserve earlier preferences unless the user revises them, and apply the latest correction first.",
          "Quick-search title candidates are metadata hints, not proof of taste or availability. Include an exact match for a direct title request unless the user ruled it out.",
          ...(tier === "extended"
            ? [
                "Choose a varied set that meets the user's genre, mood and format constraints. Prefer familiar canonical titles when a niche title's spelling or existence is uncertain.",
                "Do not infer people or cast requirements from a vague description.",
              ]
            : []),
        ].join(" ");
  const displayInstruction =
    "The acknowledgement and reasons are shown to the user. Write naturally without mentioning metadata providers, APIs, tools or validation.";

  return {
    tier,
    candidateCount,
    temperature,
    retryTemperature,
    instruction,
    displayInstruction,
    retryInstruction(previousTitles) {
      const rejected = previousTitles
        .slice(0, 12)
        .map((title) => JSON.stringify(title.slice(0, 160)))
        .join(", ");
      return [
        `Suggest ${candidateCount} different, familiar real titles that fit the user's latest request.`,
        rejected ? `Do not repeat: ${rejected}.` : "",
        "Use exact title names; use null for uncertain years. Return only JSON.",
      ]
        .filter(Boolean)
        .join(" ");
    },
  };
}
