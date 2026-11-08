import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createApp, createAppLogger } from "../src/index.js";
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

  it("protects nested secrets, child bindings and errors without mutating the original data", () => {
    let output = "";
    const logger = createAppLogger({
      destination: {
        write: (line) => {
          output += line;
        },
      },
    });
    const secrets = {
      password: "TEST_NESTED_PASSWORD_32b1",
      pin: "91287463",
      recovery: "TEST_RECOVERY_KEY_f1d3",
      token: "TEST_REFRESH_TOKEN_9a45",
      header: "TEST_COOKIE_aa91",
      error: "TEST_ERROR_MESSAGE_a9de",
      errorName: "TEST_ERROR_NAME_ae11",
      errorCode: "TEST_ERROR_CODE_a551",
      binding: "TEST_CHILD_SECRET_91de",
      url: "TEST_PRIVATE_URL_a5a4",
    };
    const cause = Object.assign(new Error(secrets.error), {
      request: { secret: secrets.error },
    });
    const customError = Object.assign(new Error(secrets.error), {
      name: secrets.errorName,
      code: secrets.errorCode,
    });
    const data = {
      code: "REDACTION_REGRESSION",
      details: {
        items: [
          {
            PassWord: secrets.password,
            Source_PIN: secrets.pin,
            safe: "retained",
          },
        ],
        nested: {
          recovery_key: secrets.recovery,
          refresh_token: secrets.token,
        },
        url: `https://example.test/${secrets.url}`,
      },
      body: { opaque: secrets.pin },
      request: { headers: { Cookie: secrets.header } },
      cause,
      err: customError,
    };
    logger
      .child({
        context: {
          secrets: { value: secrets.binding },
          safe: "binding-retained",
        },
      })
      .warn(data, "Sensitive data check");
    logger.error(new Error(secrets.error));
    logger.error({ err: new Error(secrets.error) });
    const child = logger
      .child({ details: { password: secrets.password } })
      .child({ meta: { sourcePin: secrets.pin } });
    child.setBindings({ account: { recoveryKey: secrets.recovery } });
    child.warn({ code: "CHILD_BINDING_SAFE" }, "Nested child check");
    logger.error(
      {
        err: Object.assign(new Error("ordinary failure"), {
          code: "ECONNRESET",
        }),
      },
      "Connection failed",
    );
    for (const secret of Object.values(secrets))
      expect(output).not.toContain(secret);
    expect(data.details.items[0]!.PassWord).toBe(secrets.password);
    expect(output).toContain("retained");
    expect(output).toContain("binding-retained");
    expect(output).toContain("ECONNRESET");
    expect(output).toContain("[REDACTED]");
  });

  it("logs the route template instead of user-controlled path parameters", () => {
    let output = "";
    const logger = createAppLogger({
      destination: {
        write: (line) => {
          output += line;
        },
      },
    });
    logger.info(
      {
        req: {
          method: "POST",
          url: "/api/v1/profiles/private-profile/pin?pin=91287463",
          routeOptions: { url: "/api/v1/profiles/:profileId/pin" },
        },
      },
      "request",
    );
    expect(output).toContain("/api/v1/profiles/:profileId/pin");
    expect(output).not.toContain("private-profile");
    expect(output).not.toContain("91287463");
  });

  it("does not log the Master PIN or provider password during real HTTP requests", async () => {
    let output = "";
    const pin = "91287463",
      password = "TEST_PROVIDER_PASSWORD_e4d8",
      bearer = "TEST_BEARER_TOKEN_e9f1";
    const logger = createAppLogger({
      destination: {
        write: (line) => {
          output += line;
        },
      },
    });
    const app = createApp({
      environment: "test",
      logger,
      accountServiceUrl: null,
      providerFetch: async () => {
        throw new Error(`Provider rejected ${password}`);
      },
    });
    try {
      const local = await app.inject({
        method: "POST",
        url: `/api/v1/auth/local?pin=${pin}`,
        headers: {
          authorization: `Bearer ${bearer}`,
          cookie: `session=${bearer}`,
        },
        payload: { masterPin: pin },
      });
      expect(local.statusCode).toBe(200);
      const session = String(local.headers["set-cookie"]).split(";", 1)[0]!;
      const provider = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/webshare/connect",
        headers: { cookie: session },
        payload: { username: "viewer", password },
      });
      expect(provider.statusCode).toBeGreaterThanOrEqual(400);
      expect(output).toContain("CONNECTION_CHECK_FAILED");
      expect(output).not.toContain(pin);
      expect(output).not.toContain(password);
      expect(output).not.toContain(bearer);
      expect(output).not.toContain(session);
    } finally {
      await app.close();
    }
  });
});
