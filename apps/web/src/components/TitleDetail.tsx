import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CatalogTitle,
  EpisodeSelection,
  TitleSource,
  TitleDetail as Detail,
} from "@streamer-ai/contracts";
import type { OfflineDownload, StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { sourceLabel } from "../source-label";
import { SourceIcon, sourceName } from "./SourceIcon";
import { useToasts } from "./ToastProvider";
import { playCardHoverTick } from "./TitleCard";
import { DownloadButton } from "./DownloadButton";

interface Props {
  api: StreamerApi;
  profileId: string;
  title: CatalogTitle;
  initialEpisode?: EpisodeSelection;
  playbackEnabled: boolean;
  suspended?: boolean;
  onClose: () => void;
  onOpenRelated: (title: CatalogTitle) => void;
  onPlay: (
    title: CatalogTitle,
    episode?: EpisodeSelection,
    episodeTitle?: string,
    sourceId?: string,
  ) => Promise<void>;
  onAdded: () => void;
}

const isDownloadableSource = (source: TitleSource) =>
  source.providerId === "webshare" &&
  /\.(mkv|avi|mp4|m4v|mov|webm|mpg|mpeg|ts|m2ts)$/i.test(source.releaseName);

function PlayActionContent({ label }: { label: string }) {
  return (
    <>
      <span className="play-action__icon" aria-hidden="true">
        ▶
      </span>
      <span className="play-action__label">{label}</span>
    </>
  );
}

function SourceOptionContent({
  source,
  label,
}: {
  source: TitleSource;
  label: string;
}) {
  return (
    <>
      <span className="title-detail__source-option-main">
        <SourceIcon providerId={source.providerId} />
        <span>
          <span>{label}</span>
          <small>{sourceName(source.providerId)}</small>
        </span>
      </span>
      <small className="title-detail__source-option-quality">
        {sourceLabel(source)}
      </small>
    </>
  );
}

export function TitleDetail({
  api,
  profileId,
  title,
  initialEpisode,
  playbackEnabled,
  suspended = false,
  onClose,
  onOpenRelated,
  onPlay,
  onAdded,
}: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const { showToast } = useToasts();
  const [selectedSeason, setSelectedSeason] = useState<number | null>(
    initialEpisode?.seasonNumber ?? null,
  );
  const [selectedEpisode, setSelectedEpisode] =
    useState<EpisodeSelection | null>(initialEpisode ?? null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [localRoots, setLocalRoots] = useState<{ id: string; path: string }[]>(
    [],
  );
  const [offlineJobs, setOfflineJobs] = useState<OfflineDownload[]>([]);
  const [preferredSourceId, setPreferredSourceId] = useState<string | null>(
    null,
  );
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [confirmDownload, setConfirmDownload] = useState<{
    sourceId: string;
    rootId: string;
    label: string;
  } | null>(null);
  const [chooseRoot, setChooseRoot] = useState<{
    sourceId: string;
    rootId: string;
    label: string;
  } | null>(null);
  const downloadDialogOpenRef = useRef(false);
  downloadDialogOpenRef.current =
    confirmDownload !== null || chooseRoot !== null;
  const refreshedOfflineJobs = useRef(new Set<string>());
  const reportedOfflineFailures = useRef(new Set<string>());
  const startedOfflineJobs = useRef(new Set<string>());
  const [openSourceFor, setOpenSourceFor] = useState<string | null>(null);
  const [forceSearch, setForceSearch] = useState<
    { status: "searching" } | { status: "done"; message: string } | null
  >(null);
  const [episodeSearches, setEpisodeSearches] = useState<
    Record<
      string,
      | { status: "searching" }
      | { status: "done"; sources: TitleSource[] }
      | { status: "error"; message: string }
    >
  >({});
  const openSourceForRef = useRef(openSourceFor);
  openSourceForRef.current = openSourceFor;
  const selectedEpisodeRef = useRef(selectedEpisode);
  selectedEpisodeRef.current = selectedEpisode;
  const initialSeasonNumber = initialEpisode?.seasonNumber;
  const initialEpisodeNumber = initialEpisode?.episodeNumber;

  useEffect(() => {
    if (error) showToast(error, "error");
  }, [error, showToast]);
  useEffect(() => {
    let active = true;
    void api
      .getLocalFolders()
      .then((config) => {
        if (!active) return;
        setLocalRoots(config.roots);
      })
      .catch(() => undefined);
    void api
      .getOfflineDownloads(profileId)
      .then((response) => {
        if (active) setOfflineJobs(response.items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, profileId]);
  useEffect(() => {
    let active = true;
    setPreferredSourceId(null);
    void api
      .getPreferredSource?.(profileId, title.id, selectedEpisode ?? undefined)
      .then((value) => {
        if (active) setPreferredSourceId(value.sourceId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, profileId, title.id, selectedEpisode, suspended]);
  useEffect(() => {
    if (!offlineJobs.some((job) => job.state === "downloading")) return;
    const timer = window.setTimeout(() => {
      void api
        .getOfflineDownloads(profileId)
        .then((response) => setOfflineJobs(response.items))
        .catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [api, offlineJobs, profileId]);
  useEffect(() => {
    const newlyIndexed = offlineJobs.filter(
      (job) =>
        job.titleId === title.id &&
        job.state === "complete" &&
        !refreshedOfflineJobs.current.has(job.id),
    );
    if (newlyIndexed.length === 0) return;
    for (const job of newlyIndexed) refreshedOfflineJobs.current.add(job.id);
    void api
      .getTitleDetail(profileId, title.id)
      .then((updated) => {
        setDetail(updated);
        onAdded();
        void api
          .getPreferredSource?.(
            profileId,
            title.id,
            selectedEpisode ?? undefined,
          )
          .then((value) => setPreferredSourceId(value.sourceId))
          .catch(() => undefined);
      })
      .catch(() => undefined);
  }, [api, offlineJobs, onAdded, profileId, title.id, selectedEpisode]);
  useEffect(() => {
    for (const job of offlineJobs) {
      if (
        job.state !== "failed" ||
        !startedOfflineJobs.current.has(job.id) ||
        reportedOfflineFailures.current.has(job.id)
      )
        continue;
      reportedOfflineFailures.current.add(job.id);
      showToast(job.error ?? "Offline download failed.", "error");
    }
  }, [offlineJobs, showToast]);
  const [movieStatus, setMovieStatus] = useState<
    "checking" | "ready" | "unavailable"
  >("checking");
  const closeRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const navigationFocusRef = useRef<"back" | "episode" | "seasons" | null>(
    null,
  );
  const navigationEpisodeRef = useRef<string | null>(null);
  const scrollTopRef = useRef(0);
  const lastPlayedEpisodeRef = useRef<string | null>(null);
  const wasSuspendedRef = useRef(false);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError("");
    setSelectedSeason(initialSeasonNumber ?? null);
    setSelectedEpisode(
      initialSeasonNumber !== undefined && initialEpisodeNumber !== undefined
        ? {
            seasonNumber: initialSeasonNumber,
            episodeNumber: initialEpisodeNumber,
          }
        : null,
    );
    setMovieStatus("checking");
    setOpenSourceFor(null);
    setForceSearch(null);
    setEpisodeSearches({});
    const load = async () => {
      try {
        const result = await api.getTitleDetail(profileId, title.id);
        if (active) setDetail(result);
      } catch (loadError) {
        if (active) setError(safeErrorMessage(loadError));
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [api, profileId, title.id, initialSeasonNumber, initialEpisodeNumber]);

  useEffect(() => {
    const status = detail?.series?.status;
    if (!status || status === "complete") return;
    let active = true;
    const timer = window.setInterval(
      () => {
        void api
          .getTitleDetail(profileId, title.id)
          .then((result) => {
            if (active) setDetail(result);
          })
          .catch(() => {
            if (active) setError("Episode search is temporarily unavailable.");
          });
      },
      status === "searching" ? 2500 : 60_000,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, detail?.series?.status, profileId, title.id]);

  useEffect(() => {
    if (suspended) {
      wasSuspendedRef.current = true;
      return;
    }
    if (!wasSuspendedRef.current) return;
    wasSuspendedRef.current = false;
    let active = true;
    void api
      .getTitleDetail(profileId, title.id)
      .then((result) => {
        if (active) setDetail(result);
      })
      .catch(() => {
        if (active) setError("Details could not be refreshed.");
      });
    return () => {
      active = false;
    };
  }, [api, profileId, suspended, title.id]);

  useEffect(() => {
    if (title.kind !== "movie" || !playbackEnabled) return;
    let active = true;
    void api
      .checkPlayback(profileId, title.id)
      .then(() => {
        if (active) setMovieStatus("ready");
      })
      .catch(() => {
        if (active) setMovieStatus("unavailable");
      });
    return () => {
      active = false;
    };
  }, [api, playbackEnabled, profileId, title.id, title.kind]);

  useEffect(() => {
    if (suspended) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const episodeButton = lastPlayedEpisodeRef.current
      ? dialogRef.current?.querySelector<HTMLButtonElement>(
          `button[data-episode="${lastPlayedEpisodeRef.current}"]`,
        )
      : null;
    (episodeButton ?? closeRef.current)?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (downloadDialogOpenRef.current) {
          setConfirmDownload(null);
          setChooseRoot(null);
        } else if (openSourceForRef.current !== null) setOpenSourceFor(null);
        else if (selectedEpisodeRef.current !== null) {
          const episode = selectedEpisodeRef.current;
          navigationFocusRef.current = "episode";
          navigationEpisodeRef.current = `${episode.seasonNumber}:${episode.episodeNumber}`;
          setSelectedSeason(episode.seasonNumber);
          setSelectedEpisode(null);
        } else onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const buttons = [
        ...dialogRef.current.querySelectorAll<HTMLButtonElement>(
          "button:not([disabled])",
        ),
      ];
      if (!buttons.length) return;
      if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault();
        buttons[buttons.length - 1]?.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === buttons[buttons.length - 1]
      ) {
        event.preventDefault();
        buttons[0]?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [onClose, suspended]);

  useLayoutEffect(() => {
    if (!suspended && dialogRef.current) {
      dialogRef.current.scrollTop = scrollTopRef.current;
    }
  }, [suspended]);

  useLayoutEffect(() => {
    if (suspended || !dialogRef.current) return;
    const target = navigationFocusRef.current;
    const button =
      target === "back"
        ? backRef.current
        : target === "episode" && navigationEpisodeRef.current
          ? dialogRef.current.querySelector<HTMLButtonElement>(
              `button[data-episode-details="${navigationEpisodeRef.current}"]`,
            )
          : target === "seasons"
            ? dialogRef.current.querySelector<HTMLButtonElement>(
                ".title-detail__seasons button",
              )
            : null;
    if (button) {
      button.focus({ preventScroll: true });
      navigationFocusRef.current = null;
    }
  }, [selectedEpisode, selectedSeason, detail?.series, suspended]);

  const current = detail?.title ?? title;
  const seasons = detail?.series?.seasons ?? [];
  const shownSeason =
    seasons.find((season) => season.seasonNumber === selectedSeason) ??
    seasons[0];
  const episodeCode = selectedEpisode
    ? `S${String(selectedEpisode.seasonNumber).padStart(2, "0")}E${String(selectedEpisode.episodeNumber).padStart(2, "0")}`
    : null;
  const episodeDetail = selectedEpisode
    ? seasons
        .find((season) => season.seasonNumber === selectedEpisode.seasonNumber)
        ?.episodes.find(
          (episode) => episode.episodeNumber === selectedEpisode.episodeNumber,
        )
    : null;
  const sourcesFor = (episode?: EpisodeSelection) =>
    (current.sources ?? []).filter((source) =>
      episode
        ? source.seasonNumber === episode.seasonNumber &&
          source.episodeNumber === episode.episodeNumber
        : source.seasonNumber === null && source.episodeNumber === null,
    );
  const sourceChoicesFor = (
    episode: EpisodeSelection,
    searched: TitleSource[],
  ) =>
    [...sourcesFor(episode), ...searched].filter(
      (source, index, all) =>
        all.findIndex((item) => item.id === source.id) === index,
    );
  const downloadableSourcesFor = (episode?: EpisodeSelection) =>
    sourcesFor(episode).filter(isDownloadableSource);
  const downloadJobsFor = (
    episode?: EpisodeSelection,
    explicitSource?: TitleSource,
  ) => {
    const sourceIds = explicitSource
      ? [explicitSource.id]
      : downloadableSourcesFor(episode).map((source) => source.id);
    return offlineJobs.filter(
      (job) => job.titleId === current.id && sourceIds.includes(job.sourceId),
    );
  };
  const downloadStateFor = (
    episode?: EpisodeSelection,
    source?: TitleSource,
  ) => {
    const jobs = downloadJobsFor(episode, source);
    const active = jobs.find((job) => job.state === "downloading");
    const saved = jobs.findLast((job) => job.state === "complete");
    const availableOffline = sourcesFor(episode).some(
      (candidate) => candidate.providerId === "local-files",
    );
    return {
      active,
      saved,
      state: active
        ? ("downloading" as const)
        : saved || availableOffline
          ? ("complete" as const)
          : ("idle" as const),
      progress:
        active?.totalBytes && active.totalBytes > 0
          ? Math.round((active.bytes / active.totalBytes) * 100)
          : null,
    };
  };
  const launchDownload = async (
    sourceId: string,
    rootId: string,
    replaceExisting = false,
  ) => {
    setDownloadBusy(true);
    try {
      const job = await api.startOfflineDownload(
        profileId,
        current.id,
        sourceId,
        rootId,
        replaceExisting,
      );
      startedOfflineJobs.current.add(job.id);
      setOfflineJobs((jobs) => [...jobs, job]);
    } catch (reason) {
      showToast(safeErrorMessage(reason), "error");
    } finally {
      setDownloadBusy(false);
    }
  };
  const download = async (
    episode?: EpisodeSelection,
    explicitSource?: TitleSource,
  ) => {
    if (downloadBusy) return;
    const state = downloadStateFor(episode, explicitSource);
    if (state.active) {
      try {
        await api.cancelOfflineDownload(profileId, state.active.id);
      } catch (reason) {
        showToast(safeErrorMessage(reason), "error");
      }
      return;
    }
    if (localRoots.length === 0) {
      showToast(
        "Connect a Local folder or drive in Settings before downloading.",
        "error",
      );
      return;
    }
    let source: TitleSource | undefined =
      explicitSource ?? downloadableSourcesFor(episode)[0];
    if (!source) {
      setDownloadBusy(true);
      try {
        if (episode) {
          const result = await api.forceEpisodeSearch(
            profileId,
            current.id,
            episode,
          );
          setDetail(result.detail);
          source = result.sources.find(isDownloadableSource);
        } else {
          const result = await api.forceTitleSearch(profileId, current.id);
          setDetail(result.detail);
          source = result.detail.title.sources?.find(isDownloadableSource);
        }
      } catch (reason) {
        showToast(safeErrorMessage(reason), "error");
        return;
      } finally {
        setDownloadBusy(false);
      }
    }
    if (!source) {
      showToast("No downloadable source is available for this title.", "error");
      return;
    }
    const saved = downloadJobsFor(episode, source).findLast(
      (job) => job.state === "complete",
    );
    const rootId = saved?.rootId ?? localRoots[0]!.id;
    if (saved) {
      setConfirmDownload({
        sourceId: source.id,
        rootId,
        label: episode
          ? `${current.title} S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`
          : current.title,
      });
      return;
    }
    if (localRoots.length > 1) {
      setChooseRoot({
        sourceId: source.id,
        rootId,
        label: episode
          ? `${current.title} S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`
          : current.title,
      });
      return;
    }
    await launchDownload(source.id, rootId);
  };
  const selectedEpisodeKey = selectedEpisode
    ? `${selectedEpisode.seasonNumber}:${selectedEpisode.episodeNumber}`
    : null;
  const selectedEpisodeSearch = selectedEpisodeKey
    ? episodeSearches[selectedEpisodeKey]
    : undefined;
  const episodePlayable =
    episodeDetail?.availability === "available" ||
    (selectedEpisode !== null && sourcesFor(selectedEpisode).length > 0);
  const openEpisode = (episode: EpisodeSelection) => {
    navigationFocusRef.current = "back";
    setSelectedSeason(episode.seasonNumber);
    setSelectedEpisode(episode);
    setOpenSourceFor(null);
    if (dialogRef.current) dialogRef.current.scrollTop = 0;
  };
  const showSeries = (seasonNumber: number | null) => {
    navigationFocusRef.current = seasonNumber === null ? "seasons" : "episode";
    navigationEpisodeRef.current = selectedEpisodeKey;
    setSelectedSeason(seasonNumber);
    setSelectedEpisode(null);
    setOpenSourceFor(null);
    if (dialogRef.current) dialogRef.current.scrollTop = 0;
  };
  const play = async (
    episode?: EpisodeSelection,
    episodeTitle?: string,
    sourceId?: string,
  ) => {
    scrollTopRef.current = dialogRef.current?.scrollTop ?? 0;
    lastPlayedEpisodeRef.current = episode
      ? `${episode.seasonNumber}:${episode.episodeNumber}`
      : null;
    const key = episode
      ? `${episode.seasonNumber}:${episode.episodeNumber}`
      : "movie";
    setPlaying(key);
    setError("");
    try {
      if (sourceId) await onPlay(current, episode, episodeTitle, sourceId);
      else await onPlay(current, episode, episodeTitle);
    } catch (playError) {
      setError(safeErrorMessage(playError));
    } finally {
      setPlaying(null);
    }
  };
  const add = async () => {
    setAdding(true);
    setError("");
    try {
      await api.addToLibrary(profileId, current.id);
      setDetail((value) =>
        value
          ? { ...value, title: { ...value.title, inLibrary: true } }
          : value,
      );
      onAdded();
    } catch (addError) {
      setError(safeErrorMessage(addError));
    } finally {
      setAdding(false);
    }
  };
  const searchAgain = async () => {
    if (forceSearch?.status === "searching") return;
    if (openSourceFor === "force") {
      setOpenSourceFor(null);
      return;
    }
    setOpenSourceFor("force");
    setForceSearch({ status: "searching" });
    try {
      const result = await api.forceTitleSearch(profileId, current.id);
      setDetail(result.detail);
      setForceSearch({
        status: "done",
        message:
          result.foundSources > 0
            ? `Found ${result.foundSources} playable ${result.foundSources === 1 ? "source" : "sources"}.`
            : "No new playable sources found. You can search again later.",
      });
      if (current.kind === "movie") {
        setMovieStatus("checking");
        try {
          await api.checkPlayback(profileId, current.id);
          setMovieStatus("ready");
        } catch {
          setMovieStatus("unavailable");
        }
      }
    } catch (searchError) {
      const message = safeErrorMessage(searchError);
      setForceSearch({ status: "done", message });
      setError(message);
    }
  };
  const searchEpisode = async (episode: EpisodeSelection) => {
    const key = `${episode.seasonNumber}:${episode.episodeNumber}`;
    if (episodeSearches[key]?.status === "searching") return;
    if (openSourceFor === key) {
      setOpenSourceFor(null);
      return;
    }
    setOpenSourceFor(key);
    setEpisodeSearches((searches) => ({
      ...searches,
      [key]: { status: "searching" },
    }));
    try {
      const result = await api.forceEpisodeSearch(
        profileId,
        current.id,
        episode,
      );
      setDetail(result.detail);
      setEpisodeSearches((searches) => ({
        ...searches,
        [key]: { status: "done", sources: result.sources },
      }));
    } catch (searchError) {
      const message = safeErrorMessage(searchError);
      setEpisodeSearches((searches) => ({
        ...searches,
        [key]: { status: "error", message },
      }));
      setError(message);
    }
  };

  if (suspended) return null;

  return (
    <div
      className="title-detail-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="title-detail"
        role="dialog"
        aria-modal="true"
        aria-label={`Details for ${title.title}${episodeCode ? ` ${episodeCode}` : ""}`}
      >
        <div
          className="title-detail__hero"
          style={
            current.backdropUrl
              ? {
                  backgroundImage: `linear-gradient(90deg, #09090b 20%, transparent), url(${current.backdropUrl})`,
                }
              : { backgroundColor: current.accentColor }
          }
        >
          <button
            ref={closeRef}
            className="title-detail__close close-icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close details"
          >
            ×
          </button>
          {selectedEpisode && (
            <button
              ref={backRef}
              className="title-detail__back"
              type="button"
              onClick={() => showSeries(selectedEpisode.seasonNumber)}
              aria-label={`Back to season ${selectedEpisode.seasonNumber}`}
            >
              <span aria-hidden="true">←</span> Season{" "}
              {selectedEpisode.seasonNumber}
            </button>
          )}
          <p className="eyebrow">
            {selectedEpisode
              ? `${current.title} · ${episodeCode}`
              : current.kind === "series"
                ? "Series"
                : "Movie"}
            {!selectedEpisode && current.year ? ` · ${current.year}` : ""}
          </p>
          <h2>
            {selectedEpisode
              ? (episodeDetail?.title ??
                `Episode ${selectedEpisode.episodeNumber}`)
              : current.title}
          </h2>
          {!selectedEpisode && current.genres.length > 0 && (
            <ul className="title-detail__genres" aria-label="Genres">
              {current.genres.map((genre) => (
                <li key={genre}>{genre}</li>
              ))}
            </ul>
          )}
          <p>
            {selectedEpisode
              ? episodeDetail?.synopsis ||
                (detail
                  ? "Episode description is not available."
                  : "Loading episode details…")
              : current.synopsis}
          </p>
          {!selectedEpisode && (
            <div className="title-detail__ratings">
              {current.ratings.map((rating) => (
                <span key={rating.source}>
                  {rating.source}{" "}
                  {Math.round((rating.value / rating.scale) * 100)}%
                </span>
              ))}
            </div>
          )}
          <div className="title-detail__actions">
            {selectedEpisode && playbackEnabled && (
              <button
                className={`button button--primary button--compact${episodePlayable && playing === null ? " button--play-action" : ""}`}
                type="button"
                data-episode={selectedEpisodeKey ?? undefined}
                disabled={!episodePlayable || playing !== null}
                onClick={() => void play(selectedEpisode, episodeDetail?.title)}
              >
                {playing === selectedEpisodeKey ? (
                  "Starting…"
                ) : episodePlayable ? (
                  <PlayActionContent label="Play episode" />
                ) : (
                  "Episode unavailable"
                )}
              </button>
            )}
            {selectedEpisode && (
              <>
                <button
                  className={`title-detail__force-search${selectedEpisodeSearch?.status === "searching" ? " is-searching" : ""}`}
                  type="button"
                  aria-label={`Search sources for ${episodeCode}`}
                  aria-expanded={openSourceFor === selectedEpisodeKey}
                  aria-busy={selectedEpisodeSearch?.status === "searching"}
                  disabled={
                    !playbackEnabled ||
                    selectedEpisodeSearch?.status === "searching"
                  }
                  onClick={() => void searchEpisode(selectedEpisode)}
                >
                  <span aria-hidden="true">⋮</span>
                </button>
                <button
                  className="button button--secondary button--compact"
                  type="button"
                  onClick={() => showSeries(null)}
                >
                  More episodes
                </button>
              </>
            )}
            {current.kind === "movie" && playbackEnabled && (
              <button
                className={`button button--primary button--compact${movieStatus === "checking" ? " button--checking" : ""}${movieStatus === "ready" && playing === null ? " button--play-action" : ""}`}
                type="button"
                disabled={movieStatus !== "ready" || playing !== null}
                onClick={() => void play()}
              >
                {movieStatus === "ready" ? (
                  playing === "movie" ? (
                    "Starting…"
                  ) : (
                    <PlayActionContent
                      label={
                        current.progressPercent !== null &&
                        current.progressPercent >= 2 &&
                        current.progressPercent < 95
                          ? "Continue"
                          : "Play"
                      }
                    />
                  )
                ) : movieStatus === "checking" ? (
                  "Checking"
                ) : (
                  "Currently unavailable"
                )}
              </button>
            )}
            {current.kind === "movie" && (
              <button
                className={`title-detail__force-search${forceSearch?.status === "searching" ? " is-searching" : ""}`}
                type="button"
                aria-label={`Search again for ${current.title}`}
                aria-expanded={openSourceFor === "force"}
                aria-busy={forceSearch?.status === "searching"}
                title="Force a new search for playable sources"
                disabled={
                  !playbackEnabled || forceSearch?.status === "searching"
                }
                onClick={() => void searchAgain()}
              >
                <span aria-hidden="true">⋮</span>
              </button>
            )}
            {current.kind === "movie" && openSourceFor === "force" && (
              <div
                className="title-detail__source-menu"
                role="group"
                aria-label="Search results"
              >
                <button
                  className="title-detail__source-menu-dismiss"
                  type="button"
                  aria-label="Close search results"
                  onClick={() => setOpenSourceFor(null)}
                >
                  ×
                </button>
                <strong>Search for playable sources</strong>
                <small role="status">
                  {forceSearch?.status === "searching"
                    ? "Checking this title again…"
                    : forceSearch?.message}
                </small>
                {current.kind === "movie" &&
                  forceSearch?.status === "done" &&
                  sourcesFor().length > 0 &&
                  sourcesFor().map((source, index) => (
                    <div className="title-detail__source-row" key={source.id}>
                      <button
                        type="button"
                        title={source.releaseName}
                        onClick={() => {
                          setOpenSourceFor(null);
                          void play(undefined, undefined, source.id);
                        }}
                      >
                        <SourceOptionContent
                          source={source}
                          label={
                            source.id === preferredSourceId
                              ? "Default"
                              : index === 0
                                ? "Recommended"
                                : `Source ${index + 1}`
                          }
                        />
                      </button>
                      {isDownloadableSource(source) && (
                        <DownloadButton
                          compact
                          state={downloadStateFor(undefined, source).state}
                          progress={
                            downloadStateFor(undefined, source).progress
                          }
                          label={source.releaseName}
                          onClick={() => void download(undefined, source)}
                        />
                      )}
                    </div>
                  ))}
              </div>
            )}
            {!current.inLibrary && (
              <button
                className="button button--secondary"
                type="button"
                disabled={adding}
                onClick={() => void add()}
              >
                {adding ? "Adding…" : "+ Add to Library"}
              </button>
            )}
            {current.inLibrary && (
              <span className="in-library">✓ In Library</span>
            )}
          </div>
          {(current.kind === "movie" || selectedEpisode) && playbackEnabled && (
            <div className="title-detail__hero-download">
              <DownloadButton
                state={downloadStateFor(selectedEpisode ?? undefined).state}
                progress={
                  downloadStateFor(selectedEpisode ?? undefined).progress
                }
                label={
                  selectedEpisode
                    ? `${current.title} ${episodeCode}`
                    : current.title
                }
                onClick={() => void download(selectedEpisode ?? undefined)}
              />
            </div>
          )}
        </div>
        {current.kind === "series" && selectedEpisode && (
          <div className="title-detail__body title-detail__episode-details">
            <h3>Episode details</h3>
            <p className="title-detail__episode-identity">
              Season {selectedEpisode.seasonNumber} · Episode{" "}
              {selectedEpisode.episodeNumber}
              {episodeDetail?.airDate ? ` · ${episodeDetail.airDate}` : ""}
            </p>
            {openSourceFor === selectedEpisodeKey && (
              <div
                className="title-detail__source-menu"
                role="group"
                aria-label={`Search results for ${episodeCode}`}
              >
                <button
                  className="title-detail__source-menu-dismiss"
                  type="button"
                  aria-label="Close search results"
                  onClick={() => setOpenSourceFor(null)}
                >
                  ×
                </button>
                <strong>{episodeCode} sources</strong>
                <small role="status">
                  {selectedEpisodeSearch?.status === "searching"
                    ? "Checking this episode…"
                    : selectedEpisodeSearch?.status === "error"
                      ? selectedEpisodeSearch.message
                      : selectedEpisodeSearch?.status === "done"
                        ? selectedEpisodeSearch.sources.length > 0
                          ? "Choose a playable source."
                          : "No playable sources found for this episode."
                        : null}
                </small>
                {selectedEpisodeSearch?.status === "done" &&
                  sourceChoicesFor(
                    selectedEpisode,
                    selectedEpisodeSearch.sources,
                  ).map((source, index) => (
                    <div className="title-detail__source-row" key={source.id}>
                      <button
                        type="button"
                        title={source.releaseName}
                        onClick={() => {
                          setOpenSourceFor(null);
                          void play(
                            selectedEpisode,
                            episodeDetail?.title,
                            source.id,
                          );
                        }}
                      >
                        <SourceOptionContent
                          source={source}
                          label={
                            source.id === preferredSourceId
                              ? "Default"
                              : index === 0
                                ? "Recommended"
                                : `Source ${index + 1}`
                          }
                        />
                      </button>
                      {isDownloadableSource(source) && (
                        <DownloadButton
                          compact
                          state={
                            downloadStateFor(selectedEpisode, source).state
                          }
                          progress={
                            downloadStateFor(selectedEpisode, source).progress
                          }
                          label={source.releaseName}
                          onClick={() => void download(selectedEpisode, source)}
                        />
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
        {current.kind === "series" && !selectedEpisode && (
          <div className="title-detail__body">
            <div className="title-detail__heading">
              <h3>Seasons & episodes</h3>
              <button
                className={`button button--secondary button--compact title-detail__find-episodes${detail?.series?.status === "searching" ? " is-searching" : ""}`}
                type="button"
                disabled={
                  !playbackEnabled || detail?.series?.status === "searching"
                }
                onClick={() => {
                  setError("");
                  void api
                    .getTitleDetail(profileId, title.id, true)
                    .then(setDetail)
                    .catch(() => setError("Episode search could not restart."));
                }}
              >
                {detail?.series?.status === "searching"
                  ? "Searching…"
                  : "Try to find more episodes"}
              </button>
            </div>
            {!detail && !error && <p>Loading episode guide…</p>}
            {detail?.series === null && (
              <p>Episode guide is not available in preview mode.</p>
            )}
            {detail?.series?.status === "failed" && (
              <p className="title-detail__retry-message">
                Some episodes could not be checked. Ready episodes are still
                playable.
              </p>
            )}
            {seasons.length > 0 && (
              <>
                <div className="title-detail__seasons" aria-label="Seasons">
                  {seasons.map((season) => (
                    <button
                      key={season.seasonNumber}
                      className={
                        shownSeason?.seasonNumber === season.seasonNumber
                          ? "is-active"
                          : ""
                      }
                      type="button"
                      onClick={() => setSelectedSeason(season.seasonNumber)}
                    >
                      Season {season.seasonNumber}
                    </button>
                  ))}
                </div>
                <ol className="title-detail__episodes">
                  {shownSeason?.episodes.map((episode) => {
                    const selection = {
                      seasonNumber: episode.seasonNumber,
                      episodeNumber: episode.episodeNumber,
                    };
                    const key = `${episode.seasonNumber}:${episode.episodeNumber}`;
                    const search = episodeSearches[key];
                    return (
                      <li
                        key={episode.episodeNumber}
                        className={`title-detail__episode title-detail__episode--${episode.availability}`}
                      >
                        <div>
                          <strong>
                            {episode.episodeNumber}. {episode.title}
                          </strong>
                          {episode.airDate && <small>{episode.airDate}</small>}
                        </div>
                        <span>
                          {episode.availability === "searching"
                            ? "• searching..."
                            : episode.availability === "available"
                              ? "Ready"
                              : "Unavailable"}
                        </span>
                        <div className="title-detail__episode-actions">
                          <button
                            data-episode-details={key}
                            className="button button--secondary button--compact title-detail__episode-details-button"
                            type="button"
                            onClick={() => openEpisode(selection)}
                            aria-label={`Details for ${current.title} S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`}
                          >
                            Details
                          </button>
                          {episode.availability === "available" &&
                            playbackEnabled && (
                              <button
                                className={`button button--primary button--compact${playing === `${episode.seasonNumber}:${episode.episodeNumber}` ? "" : " button--play-action"}`}
                                type="button"
                                data-episode={`${episode.seasonNumber}:${episode.episodeNumber}`}
                                disabled={playing !== null}
                                onClick={() =>
                                  void play(
                                    {
                                      seasonNumber: episode.seasonNumber,
                                      episodeNumber: episode.episodeNumber,
                                    },
                                    episode.title,
                                  )
                                }
                              >
                                {playing ===
                                `${episode.seasonNumber}:${episode.episodeNumber}` ? (
                                  "Starting…"
                                ) : current.progressPercent !== null &&
                                  current.progressPercent >= 2 &&
                                  current.resumeEpisode?.seasonNumber ===
                                    episode.seasonNumber &&
                                  current.resumeEpisode?.episodeNumber ===
                                    episode.episodeNumber ? (
                                  <PlayActionContent label="Continue" />
                                ) : (
                                  <PlayActionContent label="Play" />
                                )}
                              </button>
                            )}
                          {episode.availability === "available" &&
                            playbackEnabled && (
                              <DownloadButton
                                compact
                                state={downloadStateFor(selection).state}
                                progress={downloadStateFor(selection).progress}
                                label={`${current.title} S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`}
                                onClick={() => void download(selection)}
                              />
                            )}
                          <button
                            className={`title-detail__force-search title-detail__episode-search${search?.status === "searching" ? " is-searching" : ""}`}
                            type="button"
                            aria-label={`Search sources for episode ${episode.episodeNumber}`}
                            aria-expanded={openSourceFor === key}
                            aria-busy={search?.status === "searching"}
                            title="Force a new search for this episode"
                            disabled={
                              !playbackEnabled || search?.status === "searching"
                            }
                            onClick={() => void searchEpisode(selection)}
                          >
                            <span aria-hidden="true">⋮</span>
                          </button>
                        </div>
                        {openSourceFor === key && (
                          <div
                            className="title-detail__source-menu"
                            role="group"
                            aria-label={`Search results for episode ${episode.episodeNumber}`}
                          >
                            <button
                              className="title-detail__source-menu-dismiss"
                              type="button"
                              aria-label="Close search results"
                              onClick={() => setOpenSourceFor(null)}
                            >
                              ×
                            </button>
                            <strong>
                              Episode {episode.episodeNumber} sources
                            </strong>
                            <small role="status">
                              {search?.status === "searching"
                                ? "Checking this episode…"
                                : search?.status === "error"
                                  ? search.message
                                  : search?.status === "done"
                                    ? search.sources.length > 0
                                      ? "Choose a playable source."
                                      : "No playable sources found for this episode."
                                    : null}
                            </small>
                            {search?.status === "done" &&
                              sourceChoicesFor(selection, search.sources).map(
                                (source, index) => (
                                  <div
                                    className="title-detail__source-row"
                                    key={source.id}
                                  >
                                    <button
                                      type="button"
                                      title={source.releaseName}
                                      onClick={() => {
                                        setOpenSourceFor(null);
                                        void play(
                                          selection,
                                          episode.title,
                                          source.id,
                                        );
                                      }}
                                    >
                                      <SourceOptionContent
                                        source={source}
                                        label={
                                          source.id === preferredSourceId
                                            ? "Default"
                                            : index === 0
                                              ? "Recommended"
                                              : `Source ${index + 1}`
                                        }
                                      />
                                    </button>
                                    {isDownloadableSource(source) && (
                                      <DownloadButton
                                        compact
                                        state={
                                          downloadStateFor(selection, source)
                                            .state
                                        }
                                        progress={
                                          downloadStateFor(selection, source)
                                            .progress
                                        }
                                        label={source.releaseName}
                                        onClick={() =>
                                          void download(selection, source)
                                        }
                                      />
                                    )}
                                  </div>
                                ),
                              )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </div>
        )}
        {!selectedEpisode && (
          <div className="title-detail__body title-detail__body--related">
            <h3>More to watch</h3>
            <p>
              {current.kind === "series"
                ? "Similar series and connected stories from your catalogue."
                : "Related films and saga entries already validated in your local catalogue."}
            </p>
            {detail?.related.length === 0 && (
              <p>More recommendations will appear as you discover titles.</p>
            )}
            {(detail?.related.length ?? 0) > 0 && (
              <div className="title-detail__related">
                {detail?.related.map((related) => (
                  <button
                    type="button"
                    key={related.id}
                    onClick={() => onOpenRelated(related)}
                    onPointerEnter={(event) => {
                      if (event.pointerType === "mouse") playCardHoverTick();
                    }}
                    onFocus={playCardHoverTick}
                  >
                    {related.posterUrl && (
                      <img src={related.posterUrl} alt="" />
                    )}
                    <span>
                      {related.title}
                      {related.year ? ` (${related.year})` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {confirmDownload && (
          <div
            className="title-detail__download-confirm"
            role="dialog"
            aria-modal="true"
            aria-label="Replace offline copy"
          >
            <strong>Download again?</strong>
            <p>
              This will replace the offline copy of {confirmDownload.label}.
            </p>
            <div>
              <button type="button" onClick={() => setConfirmDownload(null)}>
                Keep existing
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  const choice = confirmDownload;
                  setConfirmDownload(null);
                  void launchDownload(choice.sourceId, choice.rootId, true);
                }}
              >
                Replace and download
              </button>
            </div>
          </div>
        )}
        {chooseRoot && (
          <div
            className="title-detail__download-confirm"
            role="dialog"
            aria-modal="true"
            aria-label="Choose download folder"
          >
            <strong>Save {chooseRoot.label} offline</strong>
            <label>
              Folder
              <select
                value={chooseRoot.rootId}
                onChange={(event) =>
                  setChooseRoot((choice) =>
                    choice ? { ...choice, rootId: event.target.value } : null,
                  )
                }
              >
                {localRoots.map((root) => (
                  <option key={root.id} value={root.id}>
                    {root.path}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <button type="button" onClick={() => setChooseRoot(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  const choice = chooseRoot;
                  setChooseRoot(null);
                  void launchDownload(choice.sourceId, choice.rootId);
                }}
              >
                Start download
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
