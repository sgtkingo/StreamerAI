import { createAppLogger, createDiagnosticLogBuffer } from "../src/logging.js";
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
  it("keeps a bounded list of classified events without arbitrary log data", () => {
    const logs = createDiagnosticLogBuffer();
    logs.capture(
      JSON.stringify({
        time: 1700000000000,
        level: 50,
        code: "PLAYBACK_MANIFEST_FAILED",
        msg: "secret",
        url: "private",
        token: "secret",
      }) + "\n",
    );
    logs.capture(
      JSON.stringify({
        time: 1700000000000,
        level: 30,
        code: "UNTRUSTED_SECRET",
      }) + "\n",
    );
    expect(logs.snapshot()).toEqual([
      {
        time: "2023-11-14T22:13:20.000Z",
        level: 50,
        code: "PLAYBACK_MANIFEST_FAILED",
      },
    ]);
    for (let i = 0; i < 120; i++)
      logs.capture(
        JSON.stringify({
          time: 1700000000000 + i,
          level: 30,
          code: "DISCOVERY_COMPLETED",
        }) + "\n",
      );
    expect(logs.snapshot()).toHaveLength(100);
  });
  it("captures actual structured logger events for the diagnostic buffer", () => {
    const logs = createDiagnosticLogBuffer();
    const logger = createAppLogger({
      destination: {
        write(chunk: string) {
          logs.capture(chunk);
        },
      },
    });
    logger.error(
      {
        code: "PLAYBACK_MANIFEST_FAILED",
        token: "secret",
        path: "/private/file",
      },
      "Failure",
    );
    expect(logs.snapshot()).toEqual([
      expect.objectContaining({ code: "PLAYBACK_MANIFEST_FAILED", level: 50 }),
    ]);
    expect(JSON.stringify(logs.snapshot())).not.toContain("secret");
    expect(JSON.stringify(logs.snapshot())).not.toContain("private");
  });
});
