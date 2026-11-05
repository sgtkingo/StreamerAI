import { describe, expect, it } from "vitest";
import { deploymentDiagnostics } from "../src/routes/deployment.js";

describe("shareable diagnostics", () => {
  it("only returns the explicitly safe platform/version fields", () => {
    process.env.STREAMERAI_TEST_SECRET = "never-share-this";
    try {
      const report = deploymentDiagnostics();
      expect(Object.keys(report).sort()).toEqual(
        [
          "format",
          "generatedAt",
          "serverVersion",
          "apiProtocol",
          "platform",
          "architecture",
          "nodeMajor",
          "includesLogs",
          "includesPersonalData",
        ].sort(),
      );
      expect(JSON.stringify(report)).not.toContain("never-share-this");
      expect(report.includesLogs).toBe(false);
    } finally {
      delete process.env.STREAMERAI_TEST_SECRET;
    }
  });
});
