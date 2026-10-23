import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createAppLogger } from "../src/index.js";
import { LOG_LEVELS, logDiscoveryEvent } from "../src/logging.js";
import { readRuntimeConfig } from "../src/runtime-config.js";
import { TEST_TOKEN } from "./fixtures.js";

describe("application logger", () => {
  it.each([
    [
      "debug",
      ["DISCOVERY_MEDIA_QUERY", "DISCOVERY_COMPLETED", "DISCOVERY_FAILED"],
    ],
    ["info", ["DISCOVERY_COMPLETED", "DISCOVERY_FAILED"]],
    ["warn", ["DISCOVERY_FAILED"]],
    ["error", []],
    ["silent", []],
  ] as const)("filters discovery diagnostics at %s", (level, expected) => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const config = readRuntimeConfig({
      NODE_ENV: "production",
      STREAMERAI_LOG_LEVEL: level,
    });
    const logger = createAppLogger({
      level: config.server.logLevel,
      destination,
    });
    for (const code of [
      "DISCOVERY_MEDIA_QUERY",
      "DISCOVERY_COMPLETED",
      "DISCOVERY_FAILED",
    ]) {
      logDiscoveryEvent(logger, { code, discoveryRequestId: "request-1" });
    }
    logger.fatal({ code: "FATAL_TEST" }, "fatal");
    const records = output.trim()
      ? output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    expect(
      records
        .filter((record) => record.code !== "FATAL_TEST")
        .map((record) => record.code),
    ).toEqual(expected);
    expect(records.some((record) => record.code === "FATAL_TEST")).toBe(
      level !== "silent",
    );
  });

  it("validates configured levels and defaults production to info", () => {
    expect(readRuntimeConfig({ NODE_ENV: "production" }).server.logLevel).toBe(
      "info",
    );
    for (const level of LOG_LEVELS) {
      expect(
        readRuntimeConfig({ STREAMERAI_LOG_LEVEL: level }).server.logLevel,
      ).toBe(level);
    }
    expect(() =>
      readRuntimeConfig({ STREAMERAI_LOG_LEVEL: "verbose" }),
    ).toThrow("STREAMERAI_LOG_LEVEL");
  });

  it("redacts known secret fields, query strings and error messages", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createAppLogger({ destination });

    logger.info(
      {
        req: {
          method: "POST",
          url: `/api/v1/integrations/tmdb/check?token=${TEST_TOKEN}`,
          headers: { authorization: `Bearer ${TEST_TOKEN}` },
        },
        body: { readAccessToken: TEST_TOKEN },
        token: TEST_TOKEN,
        err: new Error(`Provider rejected ${TEST_TOKEN}`),
      },
      "redaction check",
    );
    logger.info(
      {
        req: {
          method: "GET",
          url: `/api/v1/playback/grants/${TEST_TOKEN}/media?audio=2`,
        },
      },
      "playback request",
    );

    expect(output).not.toContain(TEST_TOKEN);
    expect(output).not.toContain("Provider rejected");
    expect(output).not.toContain("?token=");
    expect(output).not.toContain(`/grants/${TEST_TOKEN}`);
    expect(output).toContain("/grants/[REDACTED]/media");
    expect(output).toContain("[REDACTED]");
  });
});
