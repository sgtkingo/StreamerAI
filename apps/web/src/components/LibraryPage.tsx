import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CatalogTitle,
  EpisodeSelection,
  HistoryResponse,
  LibraryResponse,
  LibraryState,
  PlaybackPreferences,
} from "@streamer-ai/contracts";
import type { PlaybackGrant, StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { lockBodyScroll } from "../body-scroll-lock";
import { useToasts } from "./ToastProvider";
import { TitleCard } from "./TitleCard";
import { usePlaybackChecks } from "./usePlaybackChecks";

interface LibraryPageProps {
  api: StreamerApi;
  profileId: string;
  playbackPreferences: PlaybackPreferences;
  version: number;
  onBackHome: () => void;
  playbackEnabled: boolean;
  onPlaybackReady: (
    item: CatalogTitle,
    grant: PlaybackGrant,
    episode?: EpisodeSelection,
  ) => void;
  onOpenTitle: (item: CatalogTitle) => void;
  onDownloadSeries: (item: CatalogTitle) => void;
}

type KindFilter = "all" | "movie" | "series";
type AvailabilityFilter =
  "all" | "available" | "partial" | "unavailable" | "unknown";

interface PendingLibraryAction {
  titleId: string;
  kind: "play" | "remove";
}

export function LibraryPage({
  api,
  profileId,
  playbackPreferences,
  version,
  onBackHome,
  playbackEnabled,
  onPlaybackReady,
  onOpenTitle,
  onDownloadSeries,
}: LibraryPageProps) {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const [libraryNotice, setLibraryNotice] = useState("");
  const [pendingLibraryAction, setPendingLibraryAction] =
    useState<PendingLibraryAction | null>(null);

  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyNotice, setHistoryNotice] = useState("");
  const [historyAction, setHistoryAction] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [stateFilter, setStateFilter] = useState<"all" | LibraryState>("all");
  const [availabilityFilter, setAvailabilityFilter] =
    useState<AvailabilityFilter>("all");
  const [genreFilter, setGenreFilter] = useState("all");
  const [yearFilter, setYearFilter] = useState("all");
  const { showToast } = useToasts();

  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const historyDialogRef = useRef<HTMLElement>(null);
  const historyCloseRef = useRef<HTMLButtonElement>(null);
  const playbackChecks = usePlaybackChecks(api, profileId);

  useEffect(() => {
    if (libraryError) showToast(libraryError, "error");
  }, [libraryError, showToast]);

  useEffect(() => {
    if (libraryNotice) {
      showToast(libraryNotice, "success");
    }
  }, [libraryNotice, showToast]);

  useEffect(() => {
    if (historyError) showToast(historyError, "error");
  }, [historyError, showToast]);

  useEffect(() => {
    if (historyNotice) {
      showToast(historyNotice, "success");
    }
  }, [historyNotice, showToast]);

  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true);
    setLibraryError("");
    try {
      setLibrary(await api.getLibrary(profileId));
    } catch (error) {
      setLibraryError(safeErrorMessage(error));
    } finally {
      setLibraryLoading(false);
    }
  }, [api, profileId]);

  const togglePriority = useCallback(
    async (item: CatalogTitle) => {
      const { priority } = await api.toggleTitlePriority(profileId, item.id);
      const startsSeriesSearch =
        priority === "high" &&
        item.kind === "series" &&
        item.seriesCoverage?.complete !== true &&
        playbackEnabled &&
        item.metadataProvider !== "local-files";
      setLibrary((current) =>
        current
          ? {
              ...current,
              items: current.items.map((entry) =>
                entry.title.id === item.id
                  ? {
                      ...entry,
                      title: {
                        ...entry.title,
                        priority,
                        seriesSearchActive: startsSeriesSearch
                          ? true
                          : priority === "low"
                            ? false
                            : entry.title.seriesSearchActive,
                      },
                    }
                  : entry,
              ),
            }
          : current,
      );
      return priority;
    },
    [api, playbackEnabled, profileId],
  );

  useEffect(() => {
    const activeIds =
      library?.items
        .filter((item) => item.title.seriesSearchActive)
        .map((item) => item.title.id) ?? [];
    if (activeIds.length === 0) return;
    let active = true;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        await Promise.allSettled(
          activeIds.map((id) => api.getTitleDetail(profileId, id)),
        );
        const updated = await api.getLibrary(profileId);
        if (active) setLibrary(updated);
      } catch {
        // Keep the existing cards visible until the next refresh.
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, library, profileId]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      setHistory(await api.getHistory(profileId));
    } catch (error) {
      setHistoryError(safeErrorMessage(error));
    } finally {
      setHistoryLoading(false);
    }
  }, [api, profileId]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary, version]);

  useEffect(() => {
    if (!historyOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const historyTrigger = historyTriggerRef.current;
    const releaseScrollLock = lockBodyScroll();
    historyCloseRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setHistoryOpen(false);
        return;
      }
      if (event.key !== "Tab" || !historyDialogRef.current) return;
      const focusable = Array.from(
        historyDialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        historyDialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      releaseScrollLock();
      (previouslyFocused ?? historyTrigger)?.focus();
    };
  }, [historyOpen]);

  const openHistory = () => {
    setHistoryOpen(true);
    setConfirmClear(false);
    setHistoryNotice("");
    void loadHistory();
  };

  const remove = async (item: CatalogTitle) => {
    if (pendingLibraryAction) return;
    setPendingLibraryAction({ titleId: item.id, kind: "remove" });
    setLibraryError("");
    setLibraryNotice("");
    try {
      await api.removeFromLibrary(profileId, item.id);
      setLibraryNotice(`${item.title} was removed from your Library.`);
      await loadLibrary();
    } catch (error) {
      setLibraryError(safeErrorMessage(error));
    } finally {
      setPendingLibraryAction(null);
    }
  };

  const play = async (
    item: CatalogTitle,
    episode?: EpisodeSelection,
    sourceId?: string,
  ) => {
    if (pendingLibraryAction) return;
    setPendingLibraryAction({ titleId: item.id, kind: "play" });
    setLibraryError("");
    setLibraryNotice("");
    try {
      const response = sourceId
        ? await api.preparePlayback(profileId, item.id, episode, sourceId)
        : await api.preparePlayback(profileId, item.id, episode);
      onPlaybackReady(item, response.playback, episode);
    } catch (error) {
      if (sourceId) setLibraryError(safeErrorMessage(error));
      else playbackChecks.markFailed(item, safeErrorMessage(error), episode);
    } finally {
      setPendingLibraryAction(null);
    }
  };

  const removeHistoryEvent = async (eventId: string) => {
    if (historyAction) return;
    setHistoryAction(eventId);
    setHistoryError("");
    setHistoryNotice("");
    try {
      await api.removeHistoryEvent(profileId, eventId);
      setHistory((current) =>
        current
          ? {
              ...current,
              items: current.items.filter((item) => item.id !== eventId),
            }
          : current,
      );
      setHistoryNotice("The activity was removed from Watch History.");
    } catch (error) {
      setHistoryError(safeErrorMessage(error));
    } finally {
      setHistoryAction(null);
    }
  };

  const clearHistory = async () => {
    if (historyAction) return;
    setHistoryAction("clear");
    setHistoryError("");
    setHistoryNotice("");
    try {
      await api.clearHistory(profileId);
      setHistory((current) => (current ? { ...current, items: [] } : current));
      setConfirmClear(false);
      setHistoryNotice("Watch History was cleared. Library titles were kept.");
    } catch (error) {
      setHistoryError(safeErrorMessage(error));
    } finally {
      setHistoryAction(null);
    }
  };

  const filterOptions = useMemo(() => {
    const entries = library?.items ?? [];
    return {
      genres: [
        ...new Set(entries.flatMap((entry) => entry.title.genres)),
      ].sort(),
      years: [
        ...new Set(
          entries.flatMap((entry) =>
            entry.title.year === null ? [] : [entry.title.year],
          ),
        ),
      ].sort((a, b) => b - a),
    };
  }, [library]);

  const items = useMemo(
    () =>
      (library?.items ?? []).filter(
        (entry) =>
          (kindFilter === "all" || entry.title.kind === kindFilter) &&
          (stateFilter === "all" || entry.state === stateFilter) &&
          (availabilityFilter === "all" ||
            entry.title.availability === availabilityFilter) &&
          (genreFilter === "all" || entry.title.genres.includes(genreFilter)) &&
          (yearFilter === "all" || entry.title.year === Number(yearFilter)),
      ),
    [
      availabilityFilter,
      genreFilter,
      kindFilter,
      library,
      stateFilter,
      yearFilter,
    ],
  );

  const hasActiveFilters =
    kindFilter !== "all" ||
    stateFilter !== "all" ||
    availabilityFilter !== "all" ||
    genreFilter !== "all" ||
    yearFilter !== "all";

  const resetFilters = () => {
    setKindFilter("all");
    setStateFilter("all");
    setAvailabilityFilter("all");
    setGenreFilter("all");
    setYearFilter("all");
  };

  return (
    <main className="library-page">
      <header className="library-heading">
        <div>
          <p className="eyebrow">Your personal collection</p>
          <h1>Library</h1>
          <p>
            Saved, started and completed titles stay here independently of
            providers.
          </p>
        </div>
        <button
          ref={historyTriggerRef}
          className="button button--secondary"
          type="button"
          onClick={openHistory}
          aria-haspopup="dialog"
        >
          Watch History
        </button>
      </header>

      <section className="library-filters" aria-labelledby="filters-heading">
        <div className="filter-heading">
          <h2 id="filters-heading">Filter Library</h2>
          {hasActiveFilters && (
            <button
              className="text-button"
              type="button"
              onClick={resetFilters}
            >
              Reset filters
            </button>
          )}
        </div>
        <div className="filter-bar" aria-label="Filter by title type">
          {(["all", "movie", "series"] as const).map((value) => (
            <button
              className={kindFilter === value ? "is-active" : ""}
              type="button"
              key={value}
              aria-pressed={kindFilter === value}
              onClick={() => setKindFilter(value)}
            >
              {value === "all"
                ? "All titles"
                : value === "movie"
                  ? "Movies"
                  : "Series"}
            </button>
          ))}
        </div>
        <div className="filter-selects">
          <label>
            <span>Watch state</span>
            <select
              value={stateFilter}
              onChange={(event) =>
                setStateFilter(event.target.value as "all" | LibraryState)
              }
            >
              <option value="all">Any state</option>
              <option value="saved">Saved</option>
              <option value="in-progress">In progress</option>
              <option value="completed">Completed</option>
            </select>
          </label>
          <label>
            <span>Availability</span>
            <select
              value={availabilityFilter}
              onChange={(event) =>
                setAvailabilityFilter(event.target.value as AvailabilityFilter)
              }
            >
              <option value="all">Any availability</option>
              <option value="available">Available</option>
              <option value="partial">Partial series</option>
              <option value="unavailable">Unavailable</option>
              <option value="unknown">Not checked</option>
            </select>
          </label>
          <label>
            <span>Genre</span>
            <select
              value={genreFilter}
              onChange={(event) => setGenreFilter(event.target.value)}
            >
              <option value="all">Any genre</option>
              {filterOptions.genres.map((genre) => (
                <option key={genre} value={genre}>
                  {genre}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Year</span>
            <select
              value={yearFilter}
              onChange={(event) => setYearFilter(event.target.value)}
            >
              <option value="all">Any year</option>
              {filterOptions.years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {libraryLoading && !library ? (
        <section className="library-empty" aria-live="polite" aria-busy="true">
          <h2>Loading your Library…</h2>
        </section>
      ) : libraryError && !library ? (
        <section className="library-empty">
          <h2>Your Library could not be loaded.</h2>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => void loadLibrary()}
          >
            Try again
          </button>
        </section>
      ) : items.length > 0 ? (
        <div className="library-grid" aria-busy={libraryLoading}>
          {items.map((entry) => (
            <TitleCard
              key={entry.title.id}
              item={entry.title}
              preferences={playbackPreferences}
              onOpen={onOpenTitle}
              onDownloadSeries={onDownloadSeries}
              onPlay={play}
              onCheck={playbackChecks.check}
              onRetry={playbackChecks.retry}
              onPriority={togglePriority}
              playbackCheck={playbackChecks.stateFor(entry.title)}
              onAdd={() => undefined}
              onRemove={remove}
              pendingAction={
                pendingLibraryAction?.titleId === entry.title.id
                  ? pendingLibraryAction.kind
                  : undefined
              }
              playbackEnabled={playbackEnabled}
            />
          ))}
        </div>
      ) : library?.items.length && hasActiveFilters ? (
        <section className="library-empty">
          <h2>No titles match these filters.</h2>
          <p>Reset the filters to see your complete Library.</p>
          <button
            className="button button--secondary"
            type="button"
            onClick={resetFilters}
          >
            Reset filters
          </button>
        </section>
      ) : (
        <section className="library-empty">
          <span aria-hidden="true">＋</span>
          <h2>Your Library is ready for its first title.</h2>
          <p>
            Ask for a recommendation on Home, then save it or start watching.
          </p>
          <button
            className="button button--primary"
            type="button"
            onClick={onBackHome}
          >
            Discover something
          </button>
        </section>
      )}

      {historyOpen && (
        <div
          className="history-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setHistoryOpen(false);
          }}
        >
          <aside
            ref={historyDialogRef}
            className="history-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-heading"
            aria-describedby="history-description"
            aria-busy={historyLoading || historyAction !== null}
            tabIndex={-1}
          >
            <div className="history-panel__header">
              <div>
                <p className="eyebrow">Chronological activity</p>
                <h2 id="history-heading">Watch History</h2>
                <p id="history-description" className="sr-only">
                  Review or remove playback activity. Clearing history keeps
                  titles in your Library.
                </p>
              </div>
              <button
                ref={historyCloseRef}
                className="history-panel__close close-icon-button"
                type="button"
                aria-label="Close history"
                onClick={() => setHistoryOpen(false)}
              >
                ×
              </button>
            </div>

            {history?.items.length ? (
              <div className="history-toolbar">
                {confirmClear ? (
                  <div role="alert" className="history-confirm">
                    <span>Clear all playback activity?</span>
                    <button
                      className="button button--secondary button--compact"
                      type="button"
                      onClick={() => setConfirmClear(false)}
                      disabled={historyAction !== null}
                    >
                      Cancel
                    </button>
                    <button
                      className="button button--secondary button--compact"
                      type="button"
                      onClick={() => void clearHistory()}
                      disabled={historyAction !== null}
                    >
                      {historyAction === "clear"
                        ? "Clearing…"
                        : "Confirm clear"}
                    </button>
                  </div>
                ) : (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setConfirmClear(true)}
                  >
                    Clear history
                  </button>
                )}
              </div>
            ) : null}

            {historyLoading && !history ? (
              <p className="empty-inline" role="status">
                Loading Watch History…
              </p>
            ) : historyError && !history ? (
              <button
                className="button button--secondary"
                type="button"
                onClick={() => void loadHistory()}
              >
                Try again
              </button>
            ) : history?.items.length ? (
              <ol className="history-list">
                {history.items.map((event) => (
                  <li key={event.id}>
                    <span
                      className="history-thumb"
                      style={{ background: event.title.accentColor }}
                      aria-hidden="true"
                    >
                      {event.title.title.slice(0, 1)}
                    </span>
                    <div>
                      <strong>{event.title.title}</strong>
                      <small>
                        {event.episodeLabel ??
                          `${Math.round(event.progressPercent)}% watched`}
                      </small>
                    </div>
                    <time dateTime={event.occurredAt}>
                      {new Date(event.occurredAt).toLocaleString()}
                    </time>
                    <button
                      className="history-remove"
                      type="button"
                      aria-label={`Remove ${event.title.title} from Watch History`}
                      onClick={() => void removeHistoryEvent(event.id)}
                      disabled={historyAction !== null}
                    >
                      {historyAction === event.id ? "Removing…" : "Remove"}
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-inline">Playback events will appear here.</p>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
