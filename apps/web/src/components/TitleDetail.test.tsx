import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  CatalogTitle,
  TitleDetail as Detail,
} from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { TitleDetail } from "./TitleDetail";

const title = {
  id: "sai:tmdb:series:42",
  kind: "series",
  title: "Sample Show",
  originalTitle: null,
  year: 2021,
  synopsis: "A mystery unfolds.",
  accentColor: "#664466",
  genres: ["Mystery"],
  ratings: [],
  matchPercent: null,
  availability: "partial",
  availabilityProvider: "webshare",
  availabilityCheckedAt: "2026-09-29T20:00:00.000Z",
  formats: [
    {
      label: "1080p",
      container: "mkv",
      resolution: "1080p",
      videoCodec: "H.264",
      audioLanguages: ["en"],
      subtitleLanguages: [],
    },
  ],
  seriesCoverage: {
    seasonsAvailable: 1,
    seasonsTotal: 1,
    episodesAvailable: 1,
    episodesTotal: 2,
    complete: false,
    nextEpisodeLabel: "S01 E01",
  },
  metadataProvider: "tmdb",
  metadataValidatedAt: "2026-09-29T20:00:00.000Z",
  backdropUrl: null,
  posterUrl: null,
  inLibrary: false,
  progressPercent: null,
} satisfies CatalogTitle;

describe("TitleDetail", () => {
  it("opens an episode detail with its database synopsis and navigates back", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn().mockResolvedValue(undefined);
    const detail: Detail = {
      title,
      related: [],
      series: {
        status: "complete",
        seasons: [
          {
            seasonNumber: 1,
            title: "Season One",
            episodes: [
              {
                seasonNumber: 1,
                episodeNumber: 1,
                title: "Pilot",
                synopsis: "The story begins.",
                airDate: null,
                availability: "available",
              },
            ],
          },
          {
            seasonNumber: 2,
            title: "Season Two",
            episodes: [
              {
                seasonNumber: 2,
                episodeNumber: 3,
                title: "The Return",
                synopsis: "The hero returns home.",
                airDate: "2021-02-01",
                availability: "available",
              },
            ],
          },
        ],
      },
    };
    const api = {
      getTitleDetail: vi.fn().mockResolvedValue(detail),
    } as unknown as StreamerApi;
    render(
      <TitleDetail
        api={api}
        profileId="default"
        title={title}
        initialEpisode={{ seasonNumber: 2, episodeNumber: 3 }}
        playbackEnabled
        onClose={vi.fn()}
        onOpenRelated={vi.fn()}
        onPlay={onPlay}
        onAdded={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Details for Sample Show S02E03",
    });
    expect(
      await within(dialog).findByRole("heading", { name: "The Return" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("The hero returns home."),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Play episode" }),
    );
    expect(onPlay).toHaveBeenCalledWith(
      title,
      { seasonNumber: 2, episodeNumber: 3 },
      "The Return",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Back to season 2" }),
    );
    expect(
      within(dialog).getByRole("button", { name: "Season 2" }),
    ).toHaveClass("is-active");
    expect(
      within(dialog).getByRole("button", {
        name: "Details for Sample Show S02E03",
      }),
    ).toHaveFocus();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Details for Sample Show S02E03",
      }),
    );
    expect(
      within(dialog).getByRole("button", { name: "Back to season 2" }),
    ).toHaveFocus();
    await user.click(
      within(dialog).getByRole("button", { name: "More episodes" }),
    );
    expect(
      within(dialog).getByRole("heading", { name: "Seasons & episodes" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Season 1" }),
    ).toHaveClass("is-active");
    expect(
      within(dialog).getByRole("button", { name: "Season 1" }),
    ).toHaveFocus();
  });

  it("lets a verified episode play while later episodes are still searching", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn().mockResolvedValue(undefined);
    const detail = {
      title,
      related: [],
      series: {
        status: "searching",
        seasons: [
          {
            seasonNumber: 1,
            title: "Season One",
            episodes: [
              {
                seasonNumber: 1,
                episodeNumber: 1,
                title: "Pilot",
                airDate: "2021-01-01",
                availability: "available",
              },
              {
                seasonNumber: 1,
                episodeNumber: 2,
                title: "Next",
                airDate: "2021-01-08",
                availability: "searching",
              },
            ],
          },
        ],
      },
    } as Detail;
    const api = {
      getTitleDetail: vi.fn().mockResolvedValue(detail),
    } as unknown as StreamerApi;
    render(
      <TitleDetail
        api={api}
        profileId="default"
        title={title}
        playbackEnabled
        onClose={vi.fn()}
        onOpenRelated={vi.fn()}
        onPlay={onPlay}
        onAdded={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Details for Sample Show",
    });
    expect(await within(dialog).findByText(/Pilot/)).toBeInTheDocument();
    expect(
      within(within(dialog).getByRole("list", { name: "Genres" })).getByText(
        "Mystery",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getAllByText("• searching...").length,
    ).toBeGreaterThan(0);
    const readyEpisode = within(dialog).getByText(/Pilot/).closest("li")!;
    const pendingEpisode = within(dialog).getByText(/Next/).closest("li")!;
    expect(
      within(readyEpisode).getByRole("button", { name: /play/i }),
    ).toBeEnabled();
    expect(
      within(pendingEpisode).queryByRole("button", { name: /play/i }),
    ).not.toBeInTheDocument();
    await user.click(
      within(readyEpisode).getByRole("button", { name: /play/i }),
    );
    expect(onPlay).toHaveBeenCalledWith(
      title,
      {
        seasonNumber: 1,
        episodeNumber: 1,
      },
      "Pilot",
    );
  });

  it("shows a separate forced search control for each series episode", async () => {
    const user = userEvent.setup();
    const sources = ["source-a", "source-b"].map((candidateId, index) => ({
      id: String(index + 1).repeat(32),
      providerId: index ? "local-files" : "webshare",
      candidateId,
      releaseName: `Sample.Show.S01E01.${index ? "720p" : "1080p"}.mkv`,
      sizeBytes: 100 + index,
      format: { ...title.formats[0]!, resolution: index ? "720p" : "1080p" },
      seasonNumber: 1,
      episodeNumber: 1,
      checkedAt: "2026-09-29T20:00:00.000Z",
    }));
    const seriesTitle: CatalogTitle = { ...title, sources };
    const detail: Detail = {
      title: seriesTitle,
      related: [],
      series: {
        status: "complete",
        seasons: [
          {
            seasonNumber: 1,
            title: "Season One",
            episodes: [
              {
                seasonNumber: 1,
                episodeNumber: 1,
                title: "Pilot",
                airDate: "2021-01-01",
                availability: "available",
              },
            ],
          },
        ],
      },
    };
    const api = {
      getTitleDetail: vi.fn().mockResolvedValue(detail),
      forceEpisodeSearch: vi.fn().mockResolvedValue({ detail, sources }),
    } as unknown as StreamerApi;
    render(
      <TitleDetail
        api={api}
        profileId="default"
        title={seriesTitle}
        playbackEnabled
        onClose={vi.fn()}
        onOpenRelated={vi.fn()}
        onPlay={vi.fn().mockResolvedValue(undefined)}
        onAdded={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Details for Sample Show",
    });
    const episode = within(dialog).getByText(/Pilot/).closest("li")!;
    expect(
      within(episode).getByRole("button", { name: /play/i }),
    ).toBeEnabled();
    expect(
      within(episode).getByRole("button", {
        name: "Search sources for episode 1",
      }),
    ).toBeEnabled();
    await user.click(
      within(episode).getByRole("button", {
        name: "Search sources for episode 1",
      }),
    );
    const menu = await within(episode).findByRole("group", {
      name: "Search results for episode 1",
    });
    const localSource = await within(menu).findByRole("button", {
      name: /Source 2/,
    });
    expect(within(localSource).getByText("Local files")).toBeInTheDocument();
    expect(localSource.querySelector("img")).toHaveAttribute(
      "src",
      "/source-icons/local-files.svg",
    );
  });

  it("shows movie genres already present in validated metadata", async () => {
    const movie: CatalogTitle = {
      ...title,
      kind: "movie",
      title: "Sample Movie",
      genres: ["Drama", "Comedy"],
      availability: "available",
      seriesCoverage: null,
    };
    const api = {
      getTitleDetail: vi.fn().mockResolvedValue({
        title: movie,
        related: [],
        series: null,
      } satisfies Detail),
    } as unknown as StreamerApi;
    render(
      <TitleDetail
        api={api}
        profileId="default"
        title={movie}
        playbackEnabled={false}
        onClose={vi.fn()}
        onOpenRelated={vi.fn()}
        onPlay={vi.fn()}
        onAdded={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Details for Sample Movie",
    });
    const genres = within(dialog).getByRole("list", { name: "Genres" });
    expect(within(genres).getAllByRole("listitem")).toHaveLength(2);
    expect(within(genres).getByText("Drama")).toBeInTheDocument();
    expect(within(genres).getByText("Comedy")).toBeInTheDocument();
    expect(api.getTitleDetail).toHaveBeenCalledWith("default", movie.id);
  });

  it("plays only the movie source selected in the three-dot menu", async () => {
    const user = userEvent.setup();
    const sources = ["source-a", "source-b"].map((candidateId, index) => ({
      id: String(index + 1).repeat(32),
      providerId: index ? "ftp" : "webshare",
      candidateId,
      releaseName: `Sample.Movie.${index ? "720p" : "1080p"}.mkv`,
      sizeBytes: 100 + index,
      format: { ...title.formats[0]!, resolution: index ? "720p" : "1080p" },
      seasonNumber: null,
      episodeNumber: null,
      checkedAt: "2026-09-29T20:00:00.000Z",
    }));
    const movie: CatalogTitle = {
      ...title,
      kind: "movie",
      title: "Sample Movie",
      availability: "available",
      seriesCoverage: null,
      sources,
    };
    const api = {
      getTitleDetail: vi
        .fn()
        .mockResolvedValue({ title: movie, related: [], series: null }),
      forceTitleSearch: vi.fn().mockResolvedValue({
        detail: { title: movie, related: [], series: null },
        foundSources: 2,
      }),
      checkPlayback: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as StreamerApi;
    const onPlay = vi.fn().mockResolvedValue(undefined);
    render(
      <TitleDetail
        api={api}
        profileId="default"
        title={movie}
        playbackEnabled
        onClose={vi.fn()}
        onOpenRelated={vi.fn()}
        onPlay={onPlay}
        onAdded={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Details for Sample Movie",
    });
    await user.click(
      within(dialog).getByRole("button", {
        name: "Search again for Sample Movie",
      }),
    );
    const menu = within(dialog).getByRole("group", { name: "Search results" });
    await within(menu).findByRole("button", { name: /Source 2/ });
    expect(
      within(menu).getAllByRole("button", { name: /Recommended|Source 2/ }),
    ).toHaveLength(2);
    const alternate = within(menu).getByRole("button", { name: /Source 2/ });
    expect(within(alternate).getByText("FTP")).toBeInTheDocument();
    expect(alternate.querySelector("img")).toHaveAttribute(
      "src",
      "/source-icons/ftp.svg",
    );
    await user.click(within(menu).getByRole("button", { name: /Source 2/ }));
    expect(onPlay).toHaveBeenCalledWith(
      movie,
      undefined,
      undefined,
      sources[1]!.id,
    );
  });
});
