import { describe, expect, it } from "vitest";
import { parseManualAgentConfig } from "../src/integrations/manual-agent-config.js";

describe("manual local agent address", () => {
  it("accepts loopback and private IP addresses", () => {
    expect(
      parseManualAgentConfig({
        baseUrl: "127.0.0.1:11434",
        model: "qwen3.5:4b",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3.5:4b",
    });
    expect(
      parseManualAgentConfig({
        baseUrl: "http://10.1.2.3:11434",
        model: "qwen3.5:4b",
      }).baseUrl,
    ).toBe("http://10.1.2.3:11434");
  });

  it.each([
    "http://example.com:11434",
    "https://8.8.8.8:11434",
    "http://127.0.0.1:11434/admin",
    "http://user:pass@127.0.0.1:11434",
    "file:///etc/passwd",
  ])("rejects an unsafe address: %s", (baseUrl) => {
    expect(() =>
      parseManualAgentConfig({ baseUrl, model: "qwen3.5:4b" }),
    ).toThrow();
  });
});
