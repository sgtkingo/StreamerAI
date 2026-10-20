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
});
