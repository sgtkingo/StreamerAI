import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServerUpdateRoutes } from "../src/routes/server-updates.js";
import {
  ServerUpdateService,
  type ReleaseVerifier,
} from "../src/services/server-updates.js";

const archive = Buffer.from("signed server archive");
const artifact = {
  platform: "win-x64",
  component: "server",
  filename: "streamerai-server-0.2.0-win-x64.zip",
  bytes: archive.length,
  sha256: createHash("sha256").update(archive).digest("hex"),
  url: "https://github.com/sgtkingo/StreamerAI/releases/download/v0.2.0/streamerai-server-0.2.0-win-x64.zip",
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture({
  version = "0.2.0",
  body = archive,
  playing = false,
  hour = 14,
}: { version?: string; body?: Buffer; playing?: boolean; hour?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "streamerai-server-updates-"));
  roots.push(root);
  const state = join(root, "state");
  mkdirSync(state);
  let active = playing;
  const verifier = vi.fn<ReleaseVerifier>((input) => {
    expect(input).toMatchObject({
      platform: "win-x64",
      component: "server",
      channel: "stable",
      currentVersion: "0.1.0",
    });
    if (version === "0.0.9") throw new Error("Release downgrade refused.");
    return { metadata: { version }, artifact };
  });
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("stable.json"))
      return Response.json({ payload: "signed", signatures: [] });
    expect(url).toBe(artifact.url);
    return new Response(body);
  });
  const service = new ServerUpdateService({
    currentVersion: "0.1.0",
    stateRoot: state,
    releaseRoot: join(root, "release"),
    platform: "win32",
    fetch: fetcher,
    verifier,
    trust: { format: "streamerai-update-trust/v1" },
    now: () => new Date(2026, 10, 15, hour, 0, 0),
    isPlaybackActive: () => active,
  });
  return {
    root,
    state,
    service,
    fetcher,
    verifier,
    setPlaying: (value: boolean) => (active = value),
  };
}

describe("server updates", () => {
  it("is unavailable outside an installed Windows release", async () => {
    const service = new ServerUpdateService({ currentVersion: "0.1.0" });
    expect(await service.status()).toMatchObject({
      supported: false,
      unsupportedReason: "development",
      state: "unsupported",
    });
    await expect(service.check()).rejects.toMatchObject({
      code: "UPDATES_UNSUPPORTED",
    });
    const linux = new ServerUpdateService({
      currentVersion: "0.1.0",
      stateRoot: "/s",
      releaseRoot: "/r",
      platform: "linux",
    });
    expect((await linux.status()).unsupportedReason).toBe("platform");
  });

  it("offers a verified newer release, downloads it in the background and installs on approval", async () => {
    const { state, service, setPlaying } = fixture();
    await service.updateSettings({ autoDownload: false });
    const offered = await service.check();
    expect(offered).toMatchObject({
      state: "available",
      latestVersion: "0.2.0",
      releaseNotesUrl:
        "https://github.com/sgtkingo/StreamerAI/releases/tag/v0.2.0",
      downloadBytes: archive.length,
    });
    expect((await service.download()).state).toBe("ready");
    expect(
      readFileSync(join(state, "updates", "download", artifact.filename)),
    ).toEqual(archive);
    expect(existsSync(join(state, "updates", "download", "stable.json"))).toBe(
      true,
    );

    setPlaying(true);
    await expect(service.install("0.2.0")).rejects.toMatchObject({
      code: "PLAYBACK_ACTIVE",
    });
    await expect(service.install("0.3.0")).rejects.toMatchObject({
      code: "UPDATE_VERSION_CHANGED",
    });
    const installing = await service.install("0.2.0", {
      allowDuringPlayback: true,
    });
    expect(installing.state).toBe("installing");
    expect(
      JSON.parse(readFileSync(join(state, "updates", "request.json"), "utf8")),
    ).toMatchObject({
      format: "streamerai-update-request/v1",
      version: "0.2.0",
      metadata: "stable.json",
      artifact: artifact.filename,
    });
    await expect(
      service.install("0.2.0", { allowDuringPlayback: true }),
    ).rejects.toMatchObject({ code: "UPDATE_BUSY" });
  });

  it("automatic download is the default and a tampered archive is discarded", async () => {
    const { state, service } = fixture({
      body: Buffer.from("tampered archive!!!!!"),
    });
    await service.check();
    await vi.waitFor(async () =>
      expect((await service.status()).error).toMatch(/failed verification/),
    );
    const status = await service.status();
    expect(status.state).toBe("available");
    expect(
      existsSync(join(state, "updates", "download", artifact.filename)),
    ).toBe(false);
    await expect(service.install("0.2.0")).rejects.toMatchObject({
      code: "UPDATE_NOT_DOWNLOADED",
    });
  });

  it("reports up to date, signed older releases and verification failures", async () => {
    expect((await fixture({ version: "0.1.0" }).service.check()).state).toBe(
      "idle",
    );
    expect((await fixture({ version: "0.0.9" }).service.check()).state).toBe(
      "idle",
    );
    const broken = fixture();
    broken.verifier.mockImplementation(() => {
      throw new Error("Release signature threshold not met.");
    });
    const status = await broken.service.check();
    expect(status.state).toBe("error");
    expect(status.error).toMatch(
      /could not be verified: Release signature threshold/,
    );
  });

  it("installs at night only when enabled and nobody is watching", async () => {
    const day = fixture({ hour: 14 });
    await day.service.updateSettings({ nightlyInstall: true });
    await day.service.check();
    expect(await day.service.nightlyTick()).toBe(false);

    const night = fixture({ hour: 3, playing: true });
    await night.service.check();
    expect(await night.service.nightlyTick()).toBe(false); // disabled
    await night.service.updateSettings({ nightlyInstall: true });
    expect(await night.service.nightlyTick()).toBe(false); // watching
    night.setPlaying(false);
    expect(await night.service.nightlyTick()).toBe(true);
    expect(existsSync(join(night.state, "updates", "request.json"))).toBe(true);
  });

  it("persists settings and reminders and shows the updater's last result", async () => {
    const { state, service } = fixture();
    await service.updateSettings({ autoDownload: false, nightlyInstall: true });
    const reminded = await service.remindLater();
    expect(reminded.remindAfter).toBe(
      new Date(2026, 10, 16, 14, 0, 0).toISOString(),
    );
    writeFileSync(
      join(state, "updates", "status.json"),
      JSON.stringify({
        format: "streamerai-update-status/v1",
        state: "idle",
        result: "rolled-back",
        version: "0.2.0",
        from: "0.1.0",
        message: "did not start",
        at: "2026-11-15T03:00:00.000Z",
      }),
    );
    const restored = new ServerUpdateService({
      currentVersion: "0.1.0",
      stateRoot: state,
      releaseRoot: "r",
      platform: "win32",
    });
    expect(await restored.status()).toMatchObject({
      settings: { autoDownload: false, nightlyInstall: true },
      remindAfter: reminded.remindAfter,
      lastResult: {
        result: "rolled-back",
        version: "0.2.0",
        from: "0.1.0",
        message: "did not start",
      },
    });
  });

  it("routes require the owner and explicit install confirmation", async () => {
    const { service } = fixture();
    const app = Fastify();
    let owner = false;
    registerServerUpdateRoutes(app, {
      service,
      requireOwner: (_request, reply) => {
        if (owner) return true;
        reply
          .code(403)
          .send({ error: { code: "INSTALLATION_OWNER_REQUIRED" } });
        return false;
      },
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/server/updates" }))
        .statusCode,
    ).toBe(403);
    owner = true;
    expect(
      (
        await app.inject({ method: "GET", url: "/api/v1/server/updates" })
      ).json(),
    ).toMatchObject({ supported: true, currentVersion: "0.1.0" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/server/updates/install",
          payload: { version: "0.2.0" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/server/updates/settings",
          payload: { nightlyInstall: "yes" },
        })
      ).statusCode,
    ).toBe(400);
    const notReady = await app.inject({
      method: "POST",
      url: "/api/v1/server/updates/install",
      payload: { confirm: "install-server-update", version: "0.2.0" },
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().error.code).toBe("UPDATE_VERSION_CHANGED");
    await app.close();
  });
});
