import { describe, expect, it, vi } from "vitest";
import type { CatalogTitle } from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { retryPlaybackCheck } from "./retry-playback-check";

const movie = { id: "movie-1", kind: "movie" } as CatalogTitle;
const series = { id: "series-1", kind: "series" } as CatalogTitle;
const episode = { seasonNumber: 2, episodeNumber: 3 };

describe("retryPlaybackCheck", () => {
  it("stops after a known source passes the playback check", async () => {
    const api = {
      checkPlayback: vi.fn().mockResolvedValue({ ok: true }),
      forceTitleSearch: vi.fn(),
    } as unknown as StreamerApi;

    await expect(
      retryPlaybackCheck(api, "profile-1", movie),
    ).resolves.toMatchObject({
      ready: true,
      searched: false,
    });
    expect(api.forceTitleSearch).not.toHaveBeenCalled();
  });

  it("searches a replacement movie source only after the check fails", async () => {
    const calls: string[] = [];
    const api = {
      checkPlayback: vi.fn().mockImplementation(async () => {
        calls.push("check");
        if (calls.length === 1) throw new Error("old file missing");
        return { ok: true };
      }),
      forceTitleSearch: vi.fn().mockImplementation(async () => {
        calls.push("search");
        return { foundSources: 1 };
      }),
    } as unknown as StreamerApi;

    await expect(
      retryPlaybackCheck(api, "profile-1", movie),
    ).resolves.toMatchObject({
      ready: true,
      searched: true,
    });
    expect(calls).toEqual(["check", "search", "check"]);
  });

  it("rechecks only the requested episode after searching it", async () => {
    const api = {
      checkPlayback: vi.fn().mockRejectedValue(new Error("not playable")),
      forceEpisodeSearch: vi.fn().mockResolvedValue({ sources: [{}] }),
      forceTitleSearch: vi.fn(),
    } as unknown as StreamerApi;

    await expect(
      retryPlaybackCheck(api, "profile-1", series, episode),
    ).resolves.toMatchObject({ ready: false, searched: true });
    expect(api.checkPlayback).toHaveBeenCalledTimes(2);
    expect(api.checkPlayback).toHaveBeenCalledWith(
      "profile-1",
      "series-1",
      episode,
    );
    expect(api.forceEpisodeSearch).toHaveBeenCalledWith(
      "profile-1",
      "series-1",
      episode,
    );
    expect(api.forceTitleSearch).not.toHaveBeenCalled();
  });

  it("does not recheck when the search found no source", async () => {
    const api = {
      checkPlayback: vi.fn().mockRejectedValue(new Error("not playable")),
      forceTitleSearch: vi.fn().mockResolvedValue({ foundSources: 0 }),
    } as unknown as StreamerApi;

    await expect(
      retryPlaybackCheck(api, "profile-1", movie),
    ).resolves.toMatchObject({
      ready: false,
      searched: true,
    });
    expect(api.checkPlayback).toHaveBeenCalledOnce();
  });

  it("surfaces a provider error instead of treating it as no source", async () => {
    const api = {
      checkPlayback: vi.fn().mockRejectedValue(new Error("old file missing")),
      forceTitleSearch: vi
        .fn()
        .mockRejectedValue(new Error("provider offline")),
    } as unknown as StreamerApi;

    await expect(retryPlaybackCheck(api, "profile-1", movie)).rejects.toThrow(
      "provider offline",
    );
  });
});
