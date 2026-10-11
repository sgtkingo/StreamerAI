import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CatalogTitle } from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { usePlaybackChecks } from "./usePlaybackChecks";

describe("usePlaybackChecks", () => {
  it("leaves an unavailable title asleep until a manual retry", async () => {
    const api = {
      checkPlayback: vi.fn().mockResolvedValue({ ok: true }),
      forceTitleSearch: vi.fn(),
    } as unknown as StreamerApi;
    const movie = {
      id: "movie-1",
      kind: "movie",
      availability: "unavailable",
    } as CatalogTitle;
    const { result } = renderHook(() => usePlaybackChecks(api, "profile-1"));

    act(() => result.current.check(movie));
    expect(result.current.stateFor(movie)).toMatchObject({ status: "failed" });
    expect(api.checkPlayback).not.toHaveBeenCalled();
    act(() => result.current.retry(movie));
    await waitFor(() =>
      expect(result.current.stateFor(movie)).toMatchObject({ status: "ready" }),
    );
    expect(api.checkPlayback).toHaveBeenCalledOnce();
    expect(api.forceTitleSearch).not.toHaveBeenCalled();
  });

  it("runs the combined retry only when requested", async () => {
    const api = {
      checkPlayback: vi
        .fn()
        .mockRejectedValueOnce(new Error("missing"))
        .mockRejectedValueOnce(new Error("still missing"))
        .mockResolvedValueOnce({ ok: true }),
      forceTitleSearch: vi.fn().mockResolvedValue({ foundSources: 1 }),
    } as unknown as StreamerApi;
    const movie = { id: "movie-1", kind: "movie" } as CatalogTitle;
    const { result } = renderHook(() => usePlaybackChecks(api, "profile-1"));

    act(() => result.current.check(movie));
    await waitFor(() =>
      expect(result.current.stateFor(movie)).toMatchObject({
        status: "failed",
      }),
    );
    expect(api.forceTitleSearch).not.toHaveBeenCalled();

    act(() => result.current.retry(movie));
    await waitFor(() =>
      expect(result.current.stateFor(movie)).toMatchObject({ status: "ready" }),
    );
    expect(api.forceTitleSearch).toHaveBeenCalledOnce();
  });

  it("checks each selected series episode separately", async () => {
    const api = {
      checkPlayback: vi.fn().mockResolvedValue({
        ok: true,
        audioLanguages: ["jpn"],
        subtitleLanguages: ["cs"],
      }),
    } as unknown as StreamerApi;
    const first = {
      id: "series-1",
      kind: "series",
      resumeEpisode: { seasonNumber: 1, episodeNumber: 1 },
    } as CatalogTitle;
    const next = {
      ...first,
      resumeEpisode: { seasonNumber: 2, episodeNumber: 3 },
    } as CatalogTitle;
    const { result } = renderHook(() => usePlaybackChecks(api, "profile-1"));

    act(() => result.current.check(first, first.resumeEpisode ?? undefined));
    await waitFor(() =>
      expect(result.current.stateFor(first)).toMatchObject({ status: "ready" }),
    );
    expect(result.current.stateFor(next)).toBeUndefined();

    act(() => result.current.check(next, next.resumeEpisode ?? undefined));
    await waitFor(() =>
      expect(result.current.stateFor(next)).toMatchObject({
        status: "ready",
        audioLanguages: ["jpn"],
        subtitleLanguages: ["cs"],
      }),
    );
    expect(api.checkPlayback).toHaveBeenCalledTimes(2);
    expect(api.checkPlayback).toHaveBeenLastCalledWith(
      "profile-1",
      "series-1",
      { seasonNumber: 2, episodeNumber: 3 },
    );
  });
});
