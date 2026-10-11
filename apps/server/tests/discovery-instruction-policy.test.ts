import { describe, expect, it } from "vitest";
import {
  discoveryInstructionPolicy,
  estimateActiveParameterBillions,
} from "../src/services/discovery-instruction-policy.js";

describe("discovery instruction policy", () => {
  it("reads Ollama parameter sizes and uses active MoE size when available", () => {
    expect(estimateActiveParameterBillions("qwen3.5:4b")).toBe(4);
    expect(estimateActiveParameterBillions("model:latest", "700M")).toBe(0.7);
    expect(estimateActiveParameterBillions("model:latest", "14.2B")).toBe(14.2);
    expect(estimateActiveParameterBillions("qwen3:30b-a3b", "30.5B")).toBe(3);
    expect(
      estimateActiveParameterBillions("model:latest", "unknown"),
    ).toBeNull();
  });

  it("keeps default 4B, 4096-context instructions short and limits candidates", () => {
    const policy = discoveryInstructionPolicy({
      model: "qwen3.5:4b",
      contextTokens: 4_096,
      maxOutputTokens: 512,
      locale: "en",
    });
    expect(policy.tier).toBe("compact");
    expect(policy.candidateCount).toBe(3);
    expect(policy.instruction).toContain(
      "Suggest 3 distinct real films or series",
    );
    expect(policy.instruction).toContain("use null");
    expect(policy.instruction).toContain("concluded series");
    expect(policy.instruction).toContain("Keep people empty unless");
    expect(policy.instruction).not.toContain("Quick-search");
    expect(policy.instruction.length).toBeLessThan(700);
    expect(policy.retryInstruction(["Bad title"])).toContain(
      'Do not repeat: "Bad title"',
    );
  });

  it("uses context and output limits even with a large model", () => {
    const policy = discoveryInstructionPolicy({
      model: "large:70b",
      contextTokens: 4_096,
      maxOutputTokens: 256,
      locale: "cs",
    });
    expect(policy.tier).toBe("compact");
    expect(policy.candidateCount).toBe(1);
    expect(policy.instruction).toContain(
      "Suggest 1 distinct real films or series",
    );
  });

  it("adds preference handling for moderate models and richer matching for large ones", () => {
    const balanced = discoveryInstructionPolicy({
      model: "llama:8b",
      contextTokens: 8_192,
      maxOutputTokens: 512,
      locale: "de",
    });
    const extended = discoveryInstructionPolicy({
      model: "model:latest",
      parameterSize: "27B",
      contextTokens: 16_384,
      maxOutputTokens: 1_024,
      locale: "en",
    });
    expect(balanced.tier).toBe("balanced");
    expect(balanced.candidateCount).toBe(4);
    expect(balanced.instruction).toContain("Preserve earlier preferences");
    expect(extended.tier).toBe("extended");
    expect(extended.candidateCount).toBe(6);
    expect(extended.instruction).toContain(
      "genre, mood and format constraints",
    );
    expect(extended.instruction).toContain("vague description");
  });
});
