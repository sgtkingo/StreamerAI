import { describe, expect, it } from "vitest";
import { readRuntimeConfig } from "../src/runtime-config.js";

describe("cloud pairing configuration", () => {
  it.each([undefined, "", "   "])(
    "offers hosted cloud pairing on paired installs with service URL %j",
    (serviceUrl) => {
      const config = readRuntimeConfig({
        STREAMERAI_ACCESS_MODE: "paired",
        STREAMERAI_ACCOUNT_SERVICE_URL: serviceUrl,
      });
      expect(config.accounts?.serviceUrl).toBe(
        "https://cloud.streamer-ai.workers.dev",
      );
    },
  );

  it("preserves custom cloud services", () => {
    const config = readRuntimeConfig({
      STREAMERAI_ACCESS_MODE: "paired",
      STREAMERAI_ACCOUNT_SERVICE_URL: " https://identity.example/ ",
    });
    expect(config.accounts?.serviceUrl).toBe("https://identity.example");
  });

  it("preserves trusted local access without a configured cloud service", () => {
    expect(readRuntimeConfig({}).accounts?.serviceUrl).toBeNull();
    expect(
      readRuntimeConfig({
        STREAMERAI_ACCESS_MODE: "trusted-local",
        STREAMERAI_ACCOUNT_SERVICE_URL: "",
      }).accounts?.serviceUrl,
    ).toBeNull();
  });

  it.each([
    "http://identity.example",
    "https://identity.example/path",
    "https://user:password@identity.example",
    "https://identity.example?token=secret",
  ])("rejects unsafe cloud service URL %s", (serviceUrl) => {
    expect(() =>
      readRuntimeConfig({
        STREAMERAI_ACCESS_MODE: "paired",
        STREAMERAI_ACCOUNT_SERVICE_URL: serviceUrl,
      }),
    ).toThrow(/must be an HTTPS origin/);
  });
});
