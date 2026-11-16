import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { selectClientUpdate } from "../src/updates.js";

const keys = generateKeyPairSync("ed25519");
const now = Date.now();
const trust = {
  format: "streamerai-update-trust/v1",
  epoch: 1,
  expiresAt: new Date(now + 86_400_000).toISOString(),
  threshold: 1,
  keys: { "release-1": keys.publicKey.export({ type: "spki", format: "pem" }) },
  allowedDownloadOrigins: ["https://github.com"],
};
const artifact = (platform: string, component: string, filename: string) => ({
  platform,
  component,
  filename,
  bytes: 10,
  sha256: "a".repeat(64),
  url: `https://github.com/sgtkingo/StreamerAI/releases/download/v0.2.0/${filename}`,
});
function envelope(
  version: string,
  artifacts = [
    artifact(
      "win-x64",
      "client",
      `StreamerAI-Client-${version}-win-x64-setup.exe`,
    ),
    artifact("win-x64", "server", `streamerai-server-${version}-win-x64.zip`),
  ],
  key = keys.privateKey,
) {
  const payload = Buffer.from(
    JSON.stringify({
      format: "streamerai-signed-release/v1",
      trustEpoch: 1,
      sequence: 10,
      version,
      channel: "stable",
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      artifacts,
    }),
  );
  return {
    payload: payload.toString("base64"),
    signatures: [
      {
        keyId: "release-1",
        signature: sign(null, payload, key).toString("base64"),
      },
    ],
  };
}

describe("desktop app updates", () => {
  it("selects the signed Windows app installer of a newer release", () => {
    const update = selectClientUpdate({
      envelope: envelope("0.2.0"),
      trust,
      currentVersion: "0.1.0",
      state: {},
    });
    expect(update?.version).toBe("0.2.0");
    expect(update?.artifact.filename).toBe(
      "StreamerAI-Client-0.2.0-win-x64-setup.exe",
    );
    expect(update?.state.channels?.["1:stable"]?.sequence).toBe(10);
  });

  it("ignores current, older, unsigned or app-less releases", () => {
    expect(
      selectClientUpdate({
        envelope: envelope("0.2.0"),
        trust,
        currentVersion: "0.2.0",
        state: {},
      }),
    ).toBeNull();
    expect(
      selectClientUpdate({
        envelope: envelope("0.1.0"),
        trust,
        currentVersion: "0.2.0",
        state: {},
      }),
    ).toBeNull();
    const stranger = generateKeyPairSync("ed25519").privateKey;
    expect(
      selectClientUpdate({
        envelope: envelope("0.3.0", undefined, stranger),
        trust,
        currentVersion: "0.2.0",
        state: {},
      }),
    ).toBeNull();
    expect(
      selectClientUpdate({
        envelope: envelope("0.3.0", [
          artifact("win-x64", "server", "streamerai-server-0.3.0-win-x64.zip"),
        ]),
        trust,
        currentVersion: "0.2.0",
        state: {},
      }),
    ).toBeNull();
  });
});
