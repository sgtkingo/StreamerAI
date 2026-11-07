import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { ServerAiSetupService } from "../src/services/ollama-setup.js";
import { registerServerAiSetupRoutes } from "../src/routes/ollama-setup.js";

function fixture(initial = false) {
  let model = initial;
  let pulls = 0;
  let finish: (() => void) | undefined;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/version"))
      return Response.json({ version: "0.15.0" });
    if (url.endsWith("/api/tags"))
      return Response.json({
        models: model ? [{ name: "qwen3.5:4b" }] : [{ name: "other:latest" }],
      });
    expect(url).toBe("http://127.0.0.1:11434/api/pull");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "qwen3.5:4b",
      stream: false,
    });
    pulls++;
    await new Promise<void>((done) => {
      finish = done;
    });
    model = true;
    return Response.json({ status: "success" });
  });
  const service = new ServerAiSetupService({
    dataDirectory: ".",
    fetch: fetcher,
    installed: () => true,
    resources: () => ({
      memoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 20 * 1024 ** 3,
    }),
  });
  return { service, fetcher, pulls: () => pulls, finish: () => finish?.() };
}

describe("server-local AI setup", () => {
  it("treats malformed or oversized local API responses as unavailable, not a missing installation", async () => {
    for (const body of ["not-json", "x".repeat(300_000)]) {
      const service = new ServerAiSetupService({
        dataDirectory: ".",
        fetch: async () => new Response(body),
        installed: () => false,
      });
      const status = await service.status();
      expect(status.runtime).toBe("unavailable");
      expect(status.resources.freeDiskBytes).toBeNull();
      expect(status.resources.diskSpaceScope).toBe("unknown");
      await service.close();
    }
  });
  it("reuses installed runtimes and approved models without a new download", async () => {
    const test = fixture(true);
    expect(await test.service.status()).toMatchObject({
      runtime: "ready",
      runtimeVersion: "0.15.0",
      model: { name: "qwen3.5:4b", present: true },
      installer: { runtimeInstallFromBrowser: false },
    });
    expect(await test.service.startModelDownload()).toMatchObject({
      alreadyPresent: true,
    });
    expect(test.pulls()).toBe(0);
    await test.service.close();
  });
  it("distinguishes an installed but unavailable runtime from missing installation", async () => {
    const offline: typeof fetch = async () => {
      throw new Error("private path and environment details");
    };
    for (const installed of [true, false]) {
      const service = new ServerAiSetupService({
        dataDirectory: ".",
        fetch: offline,
        installed: () => installed,
      });
      const status = await service.status();
      expect(status.runtime).toBe(
        installed ? "installed-not-running" : "missing",
      );
      expect(JSON.stringify(status)).not.toContain("private path");
      await expect(service.startModelDownload()).rejects.toMatchObject({
        code: "OLLAMA_RUNTIME_REQUIRED",
      });
      await service.close();
    }
  });
  it("deduplicates concurrent pulls and uses only the approved fixed loopback model", async () => {
    const test = fixture();
    const [one, two] = await Promise.all([
      test.service.startModelDownload(),
      test.service.startModelDownload(),
    ]);
    expect(one.download.id).toBe(two.download.id);
    expect(one.download.state).toBe("downloading");
    expect(test.pulls()).toBe(1);
    test.finish();
    await vi.waitFor(async () =>
      expect((await test.service.status()).model.present).toBe(true),
    );
    expect((await test.service.status()).download.state).toBe("ready");
    await test.service.startModelDownload();
    expect(test.pulls()).toBe(1);
    await test.service.close();
  });
  it("checks disk space before a model download", async () => {
    const fetcher: typeof fetch = async (input) =>
      String(input).endsWith("/api/version")
        ? Response.json({ version: "0.15.0" })
        : Response.json({ models: [] });
    const service = new ServerAiSetupService({
      dataDirectory: ".",
      fetch: fetcher,
      installed: () => true,
      resources: () => ({
        memoryBytes: 8 * 1024 ** 3,
        freeDiskBytes: 512 * 1024 ** 2,
      }),
    });
    await expect(service.startModelDownload()).rejects.toMatchObject({
      code: "OLLAMA_MODEL_DISK_SPACE",
    });
    await service.close();
  });
  it("requires owner permission and explicit consent and rejects arbitrary model input", async () => {
    const test = fixture(true);
    const app = Fastify();
    registerServerAiSetupRoutes(app, {
      service: test.service,
      requireOwner: (request, reply) => {
        if (request.headers["x-test-owner"] === "yes") return true;
        reply.code(403).send({ error: "owner required" });
        return false;
      },
    });
    try {
      expect((await app.inject("/api/v1/server/ai-setup")).statusCode).toBe(
        403,
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/server/ai-setup/model",
            headers: { "x-test-owner": "yes" },
            payload: { model: "arbitrary:latest" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/server/ai-setup/model",
            headers: { "x-test-owner": "yes" },
            payload: {
              confirm: "download-recommended-local-model",
              model: "arbitrary:latest",
            },
          })
        ).statusCode,
      ).toBe(400);
      const valid = await app.inject({
        method: "POST",
        url: "/api/v1/server/ai-setup/model",
        headers: { "x-test-owner": "yes" },
        payload: { confirm: "download-recommended-local-model" },
      });
      expect(valid.statusCode).toBe(200);
      expect(valid.json().alreadyPresent).toBe(true);
      expect(test.pulls()).toBe(0);
    } finally {
      await app.close();
    }
  });
  it("never follows a model-download redirect or leaks upstream errors", async () => {
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/version"))
        return Response.json({ version: "0.15.0" });
      if (url.endsWith("/api/tags")) return Response.json({ models: [] });
      expect(init?.redirect).toBe("manual");
      return new Response("PRIVATE ERROR", {
        status: 302,
        headers: { location: "https://evil.example" },
      });
    };
    const service = new ServerAiSetupService({
      dataDirectory: ".",
      fetch: fetcher,
      resources: () => ({ memoryBytes: 16 * 1024 ** 3, freeDiskBytes: null }),
    });
    await service.startModelDownload();
    await vi.waitFor(async () =>
      expect((await service.status()).download.state).toBe("error"),
    );
    expect((await service.status()).download.error).toBe("DOWNLOAD_FAILED");
    await service.close();
  });
});
