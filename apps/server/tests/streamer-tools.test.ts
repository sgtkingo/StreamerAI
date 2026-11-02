import { describe, expect, it, vi } from "vitest";
import { StreamerToolService } from "../src/mcp/streamer-tools.js";

describe("MCP tool boundary", () => {
  it("returns bounded title facts without provider secrets or media URLs", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sessionId: "session-1",
            stage: "completed",
            reply: "Found one.",
            bestMatch: {
              reason: "A match",
              title: {
                id: "tmdb:movie:1",
                title: "Example",
                kind: "movie",
                year: 2020,
                availability: "available",
                directUrl: "https://secret.invalid/movie",
                token: "private",
              },
            },
            available: [],
            unavailable: [],
            unverified: [],
            warnings: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const service = new StreamerToolService(
      "http://127.0.0.1:4400",
      fetcher as typeof fetch,
    );
    const result = await service.call("search_media", { query: "Example" });
    expect(result.bestMatch).toMatchObject({
      title: { id: "tmdb:movie:1", title: "Example" },
    });
    expect(JSON.stringify(result)).not.toContain("secret.invalid");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects remote backend addresses and invalid tool input", async () => {
    expect(() => new StreamerToolService("https://example.com")).toThrow();
    const service = new StreamerToolService("http://localhost:4400");
    await expect(
      service.call("stop_playback", { grantId: "../outside" }),
    ).rejects.toThrow("Invalid identifier");
  });

  it("keeps an external MCP bridge within its configured profile", async () => {
    const fetcher = vi.fn();
    const service = new StreamerToolService(
      "http://127.0.0.1:4400",
      fetcher as typeof fetch,
      "viewer-2",
    );
    await expect(
      service.call("search_media", { query: "Example", profileId: "default" }),
    ).rejects.toThrow("bound to another profile");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("limits subtitle and stop tools to grants created by this MCP bridge", async () => {
    const fetcher = vi.fn(async (url: URL) => {
      const body = url.pathname.endsWith("/playback/start")
        ? { playback: { grantId: "grant-1", expiresAt: "soon" } }
        : { subtitleTracks: [], externalSubtitleTracks: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const service = new StreamerToolService(
      "http://127.0.0.1:4400",
      fetcher as typeof fetch,
      "viewer-2",
    );
    await expect(
      service.call("get_subtitles", { grantId: "another-grant" }),
    ).rejects.toThrow("did not create");
    await service.call("start_playback", {
      profileId: "viewer-2",
      titleId: "tmdb:movie:1",
    });
    await expect(
      service.call("get_subtitles", { grantId: "grant-1" }),
    ).resolves.toMatchObject({ grantId: "grant-1" });
    await service.call("stop_playback", { grantId: "grant-1" });
    await expect(
      service.call("get_subtitles", { grantId: "grant-1" }),
    ).rejects.toThrow("did not create");
  });

  it("preserves the authenticated profile context for embedded grant tools", async () => {
    const requests: Array<{ url: URL; headers: Headers }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, headers: new Headers(init?.headers) });
      return Response.json(
        url.pathname.endsWith("/playback/start")
          ? { playback: { grantId: "grant-embedded", expiresAt: "soon" } }
          : { subtitleTracks: [] },
      );
    };
    const service = new StreamerToolService(
      "http://127.0.0.1:4400",
      fetcher,
      undefined,
      "private-internal-token",
    );
    await service.call("start_playback", {
      profileId: "viewer-2",
      titleId: "tmdb:movie:1",
    });
    const subtitles = await service.call("get_subtitles", {
      profileId: "viewer-2",
      grantId: "grant-embedded",
    });
    await service.call("stop_playback", {
      profileId: "viewer-2",
      grantId: "grant-embedded",
    });
    for (const request of requests.slice(1)) {
      expect(request.url.searchParams.get("profileId")).toBe("viewer-2");
      expect(request.headers.get("x-streamer-internal-token")).toBe(
        "private-internal-token",
      );
    }
    expect(JSON.stringify(subtitles)).not.toContain("private-internal-token");
  });
});
