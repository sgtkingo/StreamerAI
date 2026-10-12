import { afterEach, describe, expect, it, vi } from "vitest";
import { openStreamerDatabase } from "@streamer-ai/database";
import type { StreamerContentProvider } from "../src/services/content-provider.js";
import { PreviewContentProvider } from "../src/services/content-provider.js";
import { StreamerCore } from "../src/services/streamer-core.js";

const databases: ReturnType<typeof openStreamerDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("scheduled availability checks", () => {
  it("rechecks a prioritized series within minutes and cancels its search when priority is lowered", async () => {
    let now = new Date("2026-09-27T12:00:00.000Z");
    const database = openStreamerDatabase({
      filename: ":memory:",
      clock: () => now,
    });
    databases.push(database);
    const preview = new PreviewContentProvider()
      .bootstrapTitles()
      .find((item) => item.title === "Dark")!;
    const title = {
      ...preview,
      availability: "partial" as const,
      seriesCoverage: {
        ...preview.seriesCoverage!,
        episodesAvailable: Math.max(
          1,
          preview.seriesCoverage!.episodesAvailable - 1,
        ),
        complete: false,
      },
    };
    const getSeriesDetail = vi
      .fn()
      .mockResolvedValue({ status: "searching", seasons: [] });
    const cancelSeriesSearch = vi.fn();
    const provider = {
      mode: "live",
      bootstrapTitles: () => [title],
      getSeriesDetail,
      cancelSeriesSearch,
    } as unknown as StreamerContentProvider;
    const core = new StreamerCore(database, () => now, provider);

    expect(core.toggleTitlePriority("default", title.id)).toBe("high");
    expect(getSeriesDetail).toHaveBeenCalledOnce();
    expect(await core.runScheduledAvailabilityChecks()).toBe(0);
    now = new Date(now.getTime() + 4 * 60_000);
    expect(await core.runScheduledAvailabilityChecks()).toBe(1);
    expect(getSeriesDetail).toHaveBeenCalledTimes(2);
    expect(core.toggleTitlePriority("default", title.id)).toBe("low");
    expect(cancelSeriesSearch).toHaveBeenCalledWith(title.id);
  });

  it("refreshes a complete series guide when due to discover new episodes", async () => {
    let now = new Date("2026-09-27T12:00:00.000Z");
    const database = openStreamerDatabase({
      filename: ":memory:",
      clock: () => now,
    });
    databases.push(database);
    const title = new PreviewContentProvider()
      .bootstrapTitles()
      .find((item) => item.title === "Dark")!;
    const getSeriesDetail = vi
      .fn()
      .mockResolvedValue({ status: "complete", seasons: [] });
    const provider = {
      mode: "live",
      bootstrapTitles: () => [title],
      getSeriesDetail,
    } as unknown as StreamerContentProvider;
    const core = new StreamerCore(database, () => now, provider);

    expect(await core.runScheduledAvailabilityChecks()).toBe(0);
    now = new Date(now.getTime() + 31 * 60 * 60_000);
    expect(await core.runScheduledAvailabilityChecks()).toBe(1);
    expect(getSeriesDetail).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ id: title.id }),
      true,
    );
  });

  it("leaves a low priority unavailable movie asleep until its daily slot", async () => {
    let now = new Date("2026-09-27T12:00:00.000Z");
    const database = openStreamerDatabase({
      filename: ":memory:",
      clock: () => now,
    });
    databases.push(database);
    const title = new PreviewContentProvider()
      .bootstrapTitles()
      .find((item) => item.title === "Before Sunrise")!;
    const forceSearchTitle = vi.fn().mockResolvedValue(title);
    const checkPlayback = vi.fn().mockRejectedValue(new Error("missing"));
    const provider = {
      mode: "live",
      bootstrapTitles: () => [title],
      forceSearchTitle,
      checkPlayback,
    } as unknown as StreamerContentProvider;
    const core = new StreamerCore(database, () => now, provider);

    expect(await core.runScheduledAvailabilityChecks()).toBe(0);
    expect(checkPlayback).not.toHaveBeenCalled();
    now = new Date(now.getTime() + 31 * 60 * 60_000);
    expect(await core.runScheduledAvailabilityChecks()).toBe(1);
    expect(checkPlayback).toHaveBeenCalledOnce();
    expect(forceSearchTitle).toHaveBeenCalledOnce();
    expect(await core.runScheduledAvailabilityChecks()).toBe(0);
  });
});
