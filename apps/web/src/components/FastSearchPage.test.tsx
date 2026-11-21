import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { DirectSearchItem, StreamerApi } from "../api/client";
import { FastSearchPage } from "./FastSearchPage";
import { EMPTY_FILTERS, filterItems, sortItems } from "./fast-search";

function item(
  providerId: string,
  candidateId: string,
  releaseName: string,
  overrides: Partial<DirectSearchItem> = {},
): DirectSearchItem {
  return {
    providerId,
    candidateId,
    directId: `direct-${candidateId.padStart(32, "0")}`,
    releaseName,
    sizeBytes: 2 * 1024 ** 3,
    providerRank: 0,
    similarity: 0.5,
    format: {
      container: "mkv",
      resolution: "1080p",
      videoCodec: "H.264",
      audioLanguages: ["cs"],
    },
    episode: null,
    votes: null,
    downloadable: providerId === "webshare",
    ...overrides,
  };
}

it("ranks by similarity or keeps each source's order, interleaved", () => {
  const items = [
    item("webshare", "1", "A", { providerRank: 0, similarity: 0.4 }),
    item("webshare", "2", "B", { providerRank: 1, similarity: 0.9 }),
    item("hellspy", "3", "C", { providerRank: 0, similarity: 0.6 }),
  ];
  const order = ["webshare", "hellspy"];
  expect(
    sortItems(items, { key: "match", direction: "desc" }, order).map(
      (entry) => entry.releaseName,
    ),
  ).toEqual(["B", "C", "A"]);
  expect(
    sortItems(items, { key: "provider", direction: "asc" }, order).map(
      (entry) => entry.releaseName,
    ),
  ).toEqual(["A", "C", "B"]);
  expect(
    sortItems(items, { key: "size", direction: "desc" }, order),
  ).toHaveLength(3);
});

it("filters by name words, columns and size range", () => {
  const items = [
    item("webshare", "1", "Dune.Part.Two.2160p.mkv", {
      sizeBytes: 20 * 1024 ** 3,
      format: {
        container: "mkv",
        resolution: "2160p",
        videoCodec: "H.265",
        audioLanguages: ["en"],
      },
    }),
    item("hellspy", "2", "Dune.1984.avi", {
      sizeBytes: 1024 ** 3,
      format: {
        container: "avi",
        resolution: null,
        videoCodec: null,
        audioLanguages: ["cs"],
      },
    }),
  ];
  const names = (filters: Partial<typeof EMPTY_FILTERS>) =>
    filterItems(items, { ...EMPTY_FILTERS, ...filters }).map(
      (entry) => entry.candidateId,
    );
  expect(names({ name: "dune two" })).toEqual(["1"]);
  expect(names({ format: "AVI" })).toEqual(["2"]);
  expect(names({ video: "2160p" })).toEqual(["1"]);
  expect(names({ audio: "CS" })).toEqual(["2"]);
  expect(names({ minSizeGb: "5" })).toEqual(["1"]);
  expect(names({ maxSizeGb: "1,5" })).toEqual(["2"]);
  expect(names({ sources: ["hellspy"] })).toEqual(["2"]);
});

function api(overrides: Partial<StreamerApi> = {}) {
  return {
    getDirectSearchProviders: vi.fn().mockResolvedValue({
      providers: [
        { id: "webshare", name: "Webshare" },
        { id: "local-files", name: "Local files" },
      ],
    }),
    directSearch: vi.fn(async (_profile: string, providerId: string) =>
      providerId === "webshare"
        ? {
            provider: "webshare",
            hasMore: true,
            items: [
              item("webshare", "w1", "Moon.2009.1080p.CZ.mkv", {
                similarity: 0.9,
              }),
            ],
          }
        : {
            provider: "local-files",
            hasMore: false,
            items: [
              item("local-files", "l1", "Moon.2009.avi", {
                similarity: 0.8,
                format: {
                  container: "avi",
                  resolution: null,
                  videoCodec: null,
                  audioLanguages: [],
                },
              }),
            ],
          },
    ),
    prepareDirectPlayback: vi.fn().mockResolvedValue({
      playback: { grantId: "grant-1" },
      title: { id: "direct-x", title: "Moon.2009.1080p.CZ.mkv" },
    }),
    inspectDirectSource: vi.fn().mockResolvedValue({
      format: {
        label: "1080p · H.264 · mkv",
        container: "mkv",
        resolution: "1080p",
        videoCodec: "H.264",
        audioLanguages: ["cs"],
        subtitleLanguages: [],
      },
      languages: { audioLanguages: ["cs", "en"], subtitleLanguages: ["cs"] },
    }),
    ...overrides,
  } as unknown as StreamerApi;
}

it("searches every source, plays a file and explains why local files cannot be saved", async () => {
  const client = api();
  const onPlaybackReady = vi.fn();
  render(
    <FastSearchPage
      api={client}
      profileId="p1"
      onPlaybackReady={onPlaybackReady}
    />,
  );
  await screen.findByRole("button", { name: /Webshare/ });
  fireEvent.change(screen.getByLabelText("Search file names"), {
    target: { value: "moon" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(
    await screen.findByRole("button", { name: "Play Moon.2009.1080p.CZ.mkv" }),
  ).toBeVisible();
  await screen.findByRole("button", { name: "Play Moon.2009.avi" });
  expect(client.directSearch).toHaveBeenCalledWith("p1", "webshare", "moon", 0);
  expect(client.directSearch).toHaveBeenCalledWith(
    "p1",
    "local-files",
    "moon",
    0,
  );

  const rows = screen.getAllByRole("row");
  const webshareRow = rows.find((row) =>
    within(row).queryByText("Moon.2009.1080p.CZ.mkv"),
  )!;
  expect(within(webshareRow).getByText("1080p · H.264")).toBeVisible();
  expect(within(webshareRow).getByText("CS")).toBeVisible();
  const localRow = rows.find((row) =>
    within(row).queryByText("Moon.2009.avi"),
  )!;
  const localDownload = within(localRow).getByRole("button", {
    name: "Download Moon.2009.avi",
  });
  expect(localDownload).toBeDisabled();
  expect(localDownload.parentElement).toHaveAttribute(
    "title",
    "This file is already on the home server.",
  );

  fireEvent.change(screen.getByLabelText("Filter by format"), {
    target: { value: "AVI" },
  });
  expect(screen.queryByText("Moon.2009.1080p.CZ.mkv")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByText("Moon.2009.1080p.CZ.mkv")).toBeVisible();

  fireEvent.click(screen.getByText("Moon.2009.1080p.CZ.mkv"));
  expect(await screen.findByText("CS, EN")).toBeVisible();

  fireEvent.click(
    screen.getByRole("button", { name: "Play Moon.2009.1080p.CZ.mkv" }),
  );
  await waitFor(() =>
    expect(onPlaybackReady).toHaveBeenCalledWith(
      expect.objectContaining({ id: "direct-x" }),
      expect.objectContaining({ grantId: "grant-1" }),
    ),
  );
  expect(
    screen.getByRole("button", { name: "Load more results" }),
  ).toBeVisible();
});

it("keeps other sources' results when one source fails", async () => {
  const client = api({
    directSearch: vi.fn(async (_profile: string, providerId: string) => {
      if (providerId === "webshare") throw new Error("Webshare is down");
      return {
        provider: "local-files",
        hasMore: false,
        items: [item("local-files", "l1", "Moon.2009.avi")],
      };
    }),
  } as Partial<StreamerApi>);
  render(
    <FastSearchPage api={client} profileId="p1" onPlaybackReady={vi.fn()} />,
  );
  await screen.findByRole("button", { name: /Webshare/ });
  fireEvent.change(screen.getByLabelText("Search file names"), {
    target: { value: "moon" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("Moon.2009.avi")).toBeVisible();
  expect(await screen.findByText("Did not answer")).toBeVisible();
});
