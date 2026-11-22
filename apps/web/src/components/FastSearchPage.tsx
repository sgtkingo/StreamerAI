import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogTitle, PlaybackGrant } from "@streamer-ai/contracts";
import type {
  DirectSearchDetails,
  DirectSearchItem,
  DirectSearchFormat,
  DirectSearchProvider,
  StreamerApi,
} from "../api/client";
import { safeErrorMessage } from "../api/client";
import { DownloadButton } from "./DownloadButton";
import { useDownloadManager } from "./DownloadManager";
import { formatDownloadSize } from "./download-size";
import { SourceIcon, sourceName } from "./SourceIcon";
import { useToasts } from "./ToastProvider";
import {
  EMPTY_FILTERS,
  audioLabel,
  durationLabel,
  filterItems,
  filterOptions,
  formatLabel,
  itemKey,
  pictureLabel,
  sortItems,
  trackLabel,
  videoLabel,
  type FastSearchFilters,
  type FastSearchSort,
  type FastSearchSortKey,
} from "./fast-search";
import "./fast-search.css";

interface ProviderResults {
  status: "loading" | "done" | "error";
  items: DirectSearchItem[];
  hasMore: boolean;
  error?: string;
}

const COLUMNS: { key: FastSearchSortKey; label: string }[] = [
  { key: "source", label: "Source" },
  { key: "name", label: "Name" },
  { key: "format", label: "Format" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
  { key: "size", label: "Size" },
];

function PlayGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

function MeasuredMark() {
  return (
    <span
      className="fast-search__measured"
      title="Measured on the file by the source"
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
        <path
          d="m3.5 8.5 3 3 6-7"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="sr-only">(measured)</span>
    </span>
  );
}

/**
 * Direct file search across connected stream sources: no AI and no catalog
 * matching. Results arrive per source and can be played or saved at once.
 */
export function FastSearchPage({
  api,
  profileId,
  onPlaybackReady,
}: {
  api: StreamerApi;
  profileId: string;
  onPlaybackReady: (title: CatalogTitle, grant: PlaybackGrant) => void;
}) {
  const manager = useDownloadManager();
  const { showToast } = useToasts();
  const [providers, setProviders] = useState<DirectSearchProvider[]>([]);
  const [providersError, setProvidersError] = useState("");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [results, setResults] = useState<Record<string, ProviderResults>>({});
  const [sort, setSort] = useState<FastSearchSort>({
    key: "match",
    direction: "desc",
  });
  const [filters, setFilters] = useState<FastSearchFilters>(EMPTY_FILTERS);
  const [details, setDetails] = useState<
    Record<string, DirectSearchDetails | "loading" | "error">
  >({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const searchId = useRef(0);

  useEffect(() => {
    if (!api.getDirectSearchProviders) return;
    let active = true;
    void api
      .getDirectSearchProviders(profileId)
      .then((response) => {
        if (active) setProviders(response.providers);
      })
      .catch((error) => {
        if (active) setProvidersError(safeErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [api, profileId]);

  /** Replaces name guesses with the streams the source measured. */
  const loadDetails = async (
    id: number,
    providerId: string,
    candidateIds: string[],
  ) => {
    if (!api.getDirectSearchDetails || candidateIds.length === 0) return;
    let found: { candidateId: string; format: DirectSearchFormat | null }[];
    try {
      found = (
        await api.getDirectSearchDetails(profileId, providerId, candidateIds)
      ).items;
    } catch {
      return; // The name-based columns stay usable.
    }
    if (searchId.current !== id) return;
    const byId = new Map(found.map((entry) => [entry.candidateId, entry]));
    setResults((current) => {
      const state = current[providerId];
      if (!state) return current;
      return {
        ...current,
        [providerId]: {
          ...state,
          items: state.items.map((item) => {
            const entry = byId.get(item.candidateId);
            if (!entry) return item;
            if (entry.format === null)
              return { ...item, unavailable: true, downloadable: false };
            return {
              ...item,
              format: entry.format,
              measured: Boolean(entry.format.details),
            };
          }),
        },
      };
    });
  };

  const loadPage = async (
    id: number,
    providerId: string,
    text: string,
    offset: number,
  ) => {
    try {
      const page = await api.directSearch!(profileId, providerId, text, offset);
      if (searchId.current !== id) return;
      setResults((current) => ({
        ...current,
        [providerId]: {
          status: "done",
          items: [...(current[providerId]?.items ?? []), ...page.items],
          hasMore: page.hasMore,
        },
      }));
      if (
        providers.find((provider) => provider.id === providerId)?.mediaDetails
      )
        void loadDetails(
          id,
          providerId,
          page.items.map((item) => item.candidateId),
        );
    } catch (error) {
      if (searchId.current !== id) return;
      setResults((current) => ({
        ...current,
        [providerId]: {
          status: "error",
          items: current[providerId]?.items ?? [],
          hasMore: false,
          error: safeErrorMessage(error),
        },
      }));
    }
  };

  const search = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !api.directSearch) return;
    const id = ++searchId.current;
    setSubmitted(trimmed);
    setDetails({});
    setExpanded(null);
    setResults(
      Object.fromEntries(
        providers.map((provider) => [
          provider.id,
          { status: "loading", items: [], hasMore: false },
        ]),
      ),
    );
    for (const provider of providers)
      void loadPage(id, provider.id, trimmed, 0);
  };

  const loadMore = () => {
    const id = searchId.current;
    for (const [providerId, state] of Object.entries(results)) {
      if (!state.hasMore || state.status !== "done") continue;
      setResults((current) => ({
        ...current,
        [providerId]: { ...current[providerId]!, status: "loading" },
      }));
      void loadPage(id, providerId, submitted, state.items.length);
    }
  };

  const all = useMemo(
    () => Object.values(results).flatMap((state) => state.items),
    [results],
  );
  const options = useMemo(() => filterOptions(all), [all]);
  const providerOrder = useMemo(
    () => providers.map((provider) => provider.id),
    [providers],
  );
  const shown = useMemo(
    () => sortItems(filterItems(all, filters), sort, providerOrder),
    [all, filters, sort, providerOrder],
  );
  const loading = Object.values(results).some(
    (state) => state.status === "loading",
  );
  const canLoadMore = Object.values(results).some(
    (state) => state.hasMore && state.status === "done",
  );
  const filtered =
    JSON.stringify({ ...filters, sources: filters.sources ?? [] }) !==
    JSON.stringify({ ...EMPTY_FILTERS, sources: [] });

  const sortBy = (key: FastSearchSortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "size" ? "desc" : "asc" },
    );
  const toggleSource = (providerId: string) =>
    setFilters((current) => {
      const selected = current.sources ?? providerOrder;
      const next = selected.includes(providerId)
        ? selected.filter((id) => id !== providerId)
        : [...selected, providerId];
      return {
        ...current,
        sources: next.length === providerOrder.length ? null : next,
      };
    });

  const play = async (item: DirectSearchItem) => {
    if (!api.prepareDirectPlayback || starting) return;
    setStarting(itemKey(item));
    try {
      const response = await api.prepareDirectPlayback(profileId, item);
      onPlaybackReady(response.title, response.playback);
    } catch (error) {
      showToast(safeErrorMessage(error), "error");
    } finally {
      setStarting(null);
    }
  };

  const toggleDetails = (item: DirectSearchItem) => {
    const key = itemKey(item);
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (details[key] && details[key] !== "error") return;
    if (!api.inspectDirectSource) return;
    setDetails((current) => ({ ...current, [key]: "loading" }));
    void api
      .inspectDirectSource(profileId, item)
      .then((result) =>
        setDetails((current) => ({ ...current, [key]: result })),
      )
      .catch(() => setDetails((current) => ({ ...current, [key]: "error" })));
  };

  const downloadState = (item: DirectSearchItem) => {
    const jobs = (manager?.jobs ?? []).filter(
      (job) => job.titleId === item.directId,
    );
    const active = jobs.find((job) => job.state === "downloading");
    if (active)
      return {
        state: "downloading" as const,
        progress: active.totalBytes
          ? (active.bytes / active.totalBytes) * 100
          : null,
        jobId: active.id,
      };
    return jobs.some((job) => job.state === "complete")
      ? { state: "complete" as const, progress: null, jobId: null }
      : { state: "idle" as const, progress: null, jobId: null };
  };

  const download = (item: DirectSearchItem) => {
    const status = downloadState(item);
    if (status.state === "downloading" && status.jobId) {
      void manager
        ?.stopSource(status.jobId)
        .catch((error) => showToast(safeErrorMessage(error), "error"));
      return;
    }
    if (status.state === "idle") manager?.requestDirect(item);
  };

  const providerStatus = (providerId: string) => {
    const state = results[providerId];
    if (!state) return "";
    if (state.status === "loading") return "Searching…";
    if (state.status === "error") return "Did not answer";
    return `${state.items.length}${state.hasMore ? "+" : ""}`;
  };

  return (
    <main className="fast-search">
      <header className="fast-search__header">
        <p className="eyebrow">Direct search</p>
        <h1>Fast search</h1>
        <p>
          Search file names directly in your connected sources. No AI and no
          catalog matching: you see exactly what each source returns.
        </p>
      </header>

      <form
        className="fast-search__bar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          search(query);
        }}
      >
        <label className="fast-search__input">
          <span className="sr-only">Search file names</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </svg>
          <input
            type="search"
            value={query}
            maxLength={200}
            placeholder="Title, release or file name"
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </label>
        <button
          className="button button--primary"
          type="submit"
          disabled={!query.trim() || providers.length === 0}
        >
          Search
        </button>
      </form>

      {providersError && (
        <p className="fast-search__notice" role="alert">
          {providersError}
        </p>
      )}
      {!providersError && providers.length === 0 && (
        <p className="fast-search__notice">
          Connect Webshare, Hellspy or a local folder in Settings to search your
          sources directly.
        </p>
      )}

      {providers.length > 0 && (
        <div className="fast-search__toolbar">
          <div
            className="fast-search__sources"
            role="group"
            aria-label="Sources"
          >
            {providers.map((provider) => {
              const selected =
                filters.sources === null ||
                filters.sources.includes(provider.id);
              return (
                <button
                  key={provider.id}
                  type="button"
                  className={`fast-search__source${selected ? " is-selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => toggleSource(provider.id)}
                >
                  <SourceIcon providerId={provider.id} />
                  <span>{provider.name}</span>
                  {submitted && (
                    <small
                      className={
                        results[provider.id]?.status === "error"
                          ? "is-error"
                          : ""
                      }
                      title={results[provider.id]?.error}
                    >
                      {providerStatus(provider.id)}
                    </small>
                  )}
                </button>
              );
            })}
          </div>
          <label className="fast-search__order">
            <span>Order</span>
            <select
              value={sort.key === "provider" ? "provider" : "match"}
              onChange={(event) =>
                setSort({
                  key: event.target.value as FastSearchSortKey,
                  direction: "desc",
                })
              }
            >
              <option value="match">Best match</option>
              <option value="provider">As the source returns it</option>
            </select>
          </label>
        </div>
      )}

      {submitted && (
        <section className="fast-search__results" aria-label="Results">
          <p className="fast-search__summary" role="status">
            {loading && all.length === 0
              ? `Searching for “${submitted}”…`
              : `${shown.length} of ${all.length} files${loading ? " · still searching" : ""}`}
            {filtered && (
              <button
                type="button"
                className="text-button"
                onClick={() => setFilters(EMPTY_FILTERS)}
              >
                Clear filters
              </button>
            )}
          </p>
          <div className="fast-search__table" role="table" aria-label="Files">
            <div className="fast-search__row fast-search__row--head" role="row">
              {COLUMNS.map((column) => (
                <div
                  key={column.key}
                  role="columnheader"
                  className={`fast-search__cell fast-search__cell--${column.key}`}
                  aria-sort={
                    sort.key === column.key
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button type="button" onClick={() => sortBy(column.key)}>
                    {column.label}
                    {sort.key === column.key && (
                      <span aria-hidden="true">
                        {sort.direction === "asc" ? " ↑" : " ↓"}
                      </span>
                    )}
                  </button>
                </div>
              ))}
              <div
                role="columnheader"
                className="fast-search__cell fast-search__cell--actions"
              >
                <span className="sr-only">Actions</span>
              </div>
            </div>
            <div
              className="fast-search__row fast-search__row--filters"
              role="row"
            >
              <div
                role="cell"
                className="fast-search__cell fast-search__cell--source"
              />
              <div
                role="cell"
                className="fast-search__cell fast-search__cell--name"
              >
                <input
                  type="search"
                  aria-label="Filter by name"
                  placeholder="Filter"
                  value={filters.name}
                  onChange={(event) =>
                    setFilters({ ...filters, name: event.target.value })
                  }
                />
              </div>
              <div
                role="cell"
                className="fast-search__cell fast-search__cell--format"
              >
                <select
                  aria-label="Filter by format"
                  value={filters.format}
                  onChange={(event) =>
                    setFilters({ ...filters, format: event.target.value })
                  }
                >
                  <option value="">Format</option>
                  {options.formats.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </div>
              <div
                role="cell"
                className="fast-search__cell fast-search__cell--video"
              >
                <select
                  aria-label="Filter by video"
                  value={filters.video}
                  onChange={(event) =>
                    setFilters({ ...filters, video: event.target.value })
                  }
                >
                  <option value="">Video</option>
                  {options.videos.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </div>
              <div
                role="cell"
                className="fast-search__cell fast-search__cell--audio"
              >
                <select
                  aria-label="Filter by audio language"
                  value={filters.audio}
                  onChange={(event) =>
                    setFilters({ ...filters, audio: event.target.value })
                  }
                >
                  <option value="">Audio</option>
                  {options.audio.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </div>
              <div
                role="cell"
                className="fast-search__cell fast-search__cell--size fast-search__size-filter"
              >
                <input
                  inputMode="decimal"
                  aria-label="Minimum size in GB"
                  placeholder="Min GB"
                  value={filters.minSizeGb}
                  onChange={(event) =>
                    setFilters({ ...filters, minSizeGb: event.target.value })
                  }
                />
                <input
                  inputMode="decimal"
                  aria-label="Maximum size in GB"
                  placeholder="Max GB"
                  value={filters.maxSizeGb}
                  onChange={(event) =>
                    setFilters({ ...filters, maxSizeGb: event.target.value })
                  }
                />
              </div>
              <div
                role="cell"
                className="fast-search__cell fast-search__cell--actions"
              />
            </div>
            {shown.map((item) => {
              const key = itemKey(item);
              const status = downloadState(item);
              const detail = details[key];
              const downloadBlocked = !item.downloadable;
              const tracks = item.format.details?.audioTracks ?? [];
              const duration = durationLabel(
                item.format.details?.durationSeconds,
              );
              const meta = [
                formatLabel(item),
                videoLabel(item),
                audioLabel(item),
                duration,
                item.sizeBytes === null
                  ? ""
                  : formatDownloadSize(item.sizeBytes),
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Fragment key={key}>
                  <div
                    className={`fast-search__row${item.unavailable ? " is-unavailable" : ""}`}
                    role="row"
                    data-meta={meta}
                    title={
                      item.unavailable
                        ? "The source no longer serves this file (removed or restricted)."
                        : undefined
                    }
                  >
                    <div
                      role="cell"
                      className="fast-search__cell fast-search__cell--source"
                    >
                      <SourceIcon providerId={item.providerId} />
                      <span className="sr-only">
                        {sourceName(item.providerId)}
                      </span>
                    </div>
                    <div
                      role="cell"
                      className="fast-search__cell fast-search__cell--name"
                    >
                      <button
                        type="button"
                        className="fast-search__name"
                        aria-expanded={expanded === key}
                        title="Show verified details"
                        onClick={() => toggleDetails(item)}
                      >
                        {item.releaseName}
                      </button>
                      {item.episode && (
                        <span className="fast-search__badge">
                          S{String(item.episode.seasonNumber).padStart(2, "0")}E
                          {String(item.episode.episodeNumber).padStart(2, "0")}
                        </span>
                      )}
                      {duration && (
                        <span className="fast-search__badge fast-search__badge--quiet">
                          {duration}
                        </span>
                      )}
                      {item.unavailable && (
                        <span className="fast-search__badge fast-search__badge--warn">
                          Unavailable
                        </span>
                      )}
                    </div>
                    <div
                      role="cell"
                      className="fast-search__cell fast-search__cell--format"
                      data-label="Format"
                    >
                      {formatLabel(item) || "—"}
                    </div>
                    <div
                      role="cell"
                      className="fast-search__cell fast-search__cell--video"
                      data-label="Video"
                      title={pictureLabel(item.format.details) || undefined}
                    >
                      {videoLabel(item) || "—"}
                      {item.measured && <MeasuredMark />}
                    </div>
                    <div
                      role="cell"
                      className="fast-search__cell fast-search__cell--audio"
                      data-label="Audio"
                      title={tracks.map(trackLabel).join("\n") || undefined}
                    >
                      {audioLabel(item) || "—"}
                      {item.measured && tracks.length > 0 && <MeasuredMark />}
                    </div>
                    <div
                      role="cell"
                      className="fast-search__cell fast-search__cell--size"
                      data-label="Size"
                    >
                      {item.sizeBytes === null
                        ? "—"
                        : formatDownloadSize(item.sizeBytes)}
                    </div>
                    <div
                      role="cell"
                      className="fast-search__cell fast-search__cell--actions"
                    >
                      <button
                        type="button"
                        className="fast-search__play"
                        aria-label={`Play ${item.releaseName}`}
                        aria-busy={starting === key || undefined}
                        disabled={starting !== null || item.unavailable}
                        onClick={() => void play(item)}
                      >
                        {starting === key ? (
                          <span
                            className="fast-search__spinner"
                            aria-hidden="true"
                          />
                        ) : (
                          <PlayGlyph />
                        )}
                      </button>
                      <span
                        title={
                          downloadBlocked
                            ? item.providerId === "local-files"
                              ? "This file is already on the home server."
                              : "Saving offline is available for Webshare video files."
                            : undefined
                        }
                      >
                        <DownloadButton
                          compact
                          state={status.state}
                          progress={status.progress}
                          label={item.releaseName}
                          disabled={
                            downloadBlocked || status.state === "complete"
                          }
                          stopLabel="Stop"
                          onClick={() => download(item)}
                        />
                      </span>
                    </div>
                  </div>
                  {expanded === key && (
                    <div className="fast-search__details" role="row">
                      <div role="cell">
                        {detail === "loading" || detail === undefined ? (
                          <span role="status">Reading the file…</span>
                        ) : detail === "error" ? (
                          <span role="alert">
                            The file details could not be read.
                          </span>
                        ) : (
                          <dl>
                            <div>
                              <dt>Format</dt>
                              <dd>{detail.format.label}</dd>
                            </div>
                            {pictureLabel(detail.format.details) && (
                              <div>
                                <dt>Picture</dt>
                                <dd>{pictureLabel(detail.format.details)}</dd>
                              </div>
                            )}
                            {durationLabel(
                              detail.format.details?.durationSeconds,
                            ) && (
                              <div>
                                <dt>Length</dt>
                                <dd>
                                  {durationLabel(
                                    detail.format.details?.durationSeconds,
                                  )}
                                </dd>
                              </div>
                            )}
                            <div>
                              <dt>Audio</dt>
                              <dd>
                                {detail.format.details?.audioTracks.length
                                  ? detail.format.details.audioTracks
                                      .map(trackLabel)
                                      .join(", ")
                                  : (
                                      detail.languages?.audioLanguages ??
                                      detail.format.audioLanguages
                                    )
                                      .map((code) => code.toUpperCase())
                                      .join(", ") || "Unknown"}
                              </dd>
                            </div>
                            <div>
                              <dt>Subtitles</dt>
                              <dd>
                                {(
                                  detail.languages?.subtitleLanguages ??
                                  detail.format.subtitleLanguages
                                )
                                  .map((code) => code.toUpperCase())
                                  .join(", ") || "None found"}
                              </dd>
                            </div>
                          </dl>
                        )}
                      </div>
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
          {!loading && all.length === 0 && (
            <p className="fast-search__notice">
              No files found for “{submitted}”. Try fewer or different words.
            </p>
          )}
          {all.length > 0 && shown.length === 0 && (
            <p className="fast-search__notice">No file matches the filters.</p>
          )}
          {canLoadMore && (
            <button
              type="button"
              className="button button--secondary fast-search__more"
              disabled={loading}
              onClick={loadMore}
            >
              Load more results
            </button>
          )}
        </section>
      )}
    </main>
  );
}
