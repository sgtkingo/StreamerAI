import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CatalogTitle,
  EpisodeSelection,
  TitleDetail,
  TitleSource,
} from "@streamer-ai/contracts";
import type { OfflineDownload, StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { useToasts } from "./ToastProvider";
import { formatDownloadSize } from "./download-size";
import { refreshMissingEpisodesForDownload } from "./batch-availability";

const downloadable = (source: TitleSource) =>
  source.providerId === "webshare" &&
  /\.(mkv|avi|mp4|m4v|mov|webm|mpg|mpeg|ts|m2ts)$/i.test(source.releaseName);
const episodeKey = (episode: EpisodeSelection) =>
  `${episode.seasonNumber}:${episode.episodeNumber}`;
const batchKey = (titleId: string, seasonNumber?: number) =>
  `${titleId}:${seasonNumber ?? "all"}`;
const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export interface DownloadBatch {
  key: string;
  titleId: string;
  title: string;
  seasonNumber?: number;
  status:
    | "preparing"
    | "confirming"
    | "choosing-folder"
    | "downloading"
    | "stopping"
    | "stopped"
    | "complete"
    | "partial"
    | "failed";
  total: number;
  processed: number;
  failed: number;
  currentEpisode?: EpisodeSelection;
  currentJobId?: string;
  error?: string;
}

export interface DownloadBatchView {
  action: "download" | "stop" | "delete" | "retry";
  state: "idle" | "downloading" | "complete";
  progress: number | null;
  entry?: DownloadBatch;
  saved: number;
  available: number;
}

interface BatchRun {
  stopped: boolean;
  currentJobId?: string;
}

interface FolderPrompt {
  roots: { id: string; path: string }[];
  rootId: string;
  label: string;
  start: (rootId: string) => void;
  cancel: () => void;
}

interface DeletePrompt {
  jobs: OfflineDownload[];
  label: string;
}

interface BatchPrompt {
  key: string;
  title: string;
  seasonNumber?: number;
  count: number;
  missingCount: number;
  knownBytes: number;
  unknownSizes: number;
  start: () => void;
  cancel: () => void;
}

interface DownloadContextValue {
  jobs: OfflineDownload[];
  batches: Record<string, DownloadBatch>;
  details: Record<string, TitleDetail>;
  libraryRevision: number;
  stoppingJobIds: string[];
  refresh: () => Promise<OfflineDownload[]>;
  batchFor: (title: CatalogTitle, seasonNumber?: number) => DownloadBatchView;
  movieFor: (title: CatalogTitle) => DownloadBatchView;
  activateBatch: (title: CatalogTitle, seasonNumber?: number) => void;
  activateMovie: (title: CatalogTitle) => void;
  stopBatch: (titleId: string, seasonNumber?: number) => void;
  requestSource: (
    title: CatalogTitle,
    source: TitleSource,
    replaceExisting?: boolean,
  ) => void;
  stopSource: (jobId: string) => Promise<void>;
  confirmDelete: (jobs: OfflineDownload[], label: string) => void;
  findSources: (title: CatalogTitle, episode?: EpisodeSelection) => Promise<void>;
  loadDetail: (titleId: string) => Promise<TitleDetail>;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

export function useDownloadManager() {
  return useContext(DownloadContext);
}

export function DownloadProvider({
  api,
  profileId,
  children,
}: {
  api: StreamerApi;
  profileId: string;
  children: ReactNode;
}) {
  const { showToast } = useToasts();
  const [jobs, setJobs] = useState<OfflineDownload[]>([]);
  const jobsRef = useRef(jobs);
  const [details, setDetails] = useState<Record<string, TitleDetail>>({});
  const [batches, setBatches] = useState<Record<string, DownloadBatch>>({});
  const batchesRef = useRef(batches);
  const runs = useRef(new Map<string, BatchRun>());
  const [folderPrompt, setFolderPrompt] = useState<FolderPrompt | null>(null);
  const folderPromptRef = useRef(folderPrompt);
  folderPromptRef.current = folderPrompt;
  const [batchPrompt, setBatchPrompt] = useState<BatchPrompt | null>(null);
  const batchPromptRef = useRef(batchPrompt);
  batchPromptRef.current = batchPrompt;
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [stoppingJobIds, setStoppingJobIds] = useState<string[]>([]);

  const updateJobs = useCallback((next: OfflineDownload[]) => {
    const previous = jobsRef.current;
    const oldStates = new Map(previous.map((job) => [job.id, job.state]));
    if (
      next.some(
        (job) =>
          job.state === "complete" && oldStates.get(job.id) !== "complete",
      ) ||
      previous.some(
        (job) =>
          job.state === "complete" && !next.some((item) => item.id === job.id),
      )
    )
      setLibraryRevision((value) => value + 1);
    jobsRef.current = next;
    setJobs(next);
  }, []);
  const refresh = useCallback(async () => {
    const response = await api.getOfflineDownloads(profileId);
    updateJobs(response.items);
    return response.items;
  }, [api, profileId, updateJobs]);

  useEffect(() => {
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        if (active) await refresh();
      } catch {
        // Keep the last known progress while the server is unreachable.
      }
      if (active)
        timer = window.setTimeout(
          poll,
          jobsRef.current.some((job) => job.state === "downloading")
            ? 1200
            : 5000,
        );
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    setStoppingJobIds((current) => {
      const next = current.filter((id) => jobs.some((job) => job.id === id && job.state === "downloading"));
      return next.length === current.length ? current : next;
    });
  }, [jobs]);

  const updateBatch = useCallback((key: string, patch: Partial<DownloadBatch>) => {
    const previous = batchesRef.current[key];
    if (!previous) return;
    const next = { ...batchesRef.current, [key]: { ...previous, ...patch } };
    batchesRef.current = next;
    setBatches(next);
  }, []);
  const createBatch = useCallback((entry: DownloadBatch) => {
    const next = { ...batchesRef.current, [entry.key]: entry };
    batchesRef.current = next;
    setBatches(next);
  }, []);

  const stopBatch = useCallback(
    (titleId: string, seasonNumber?: number) => {
      const key = batchKey(titleId, seasonNumber);
      const keys = seasonNumber === undefined
        ? [...runs.current.keys()].filter((candidate) => candidate.startsWith(`${titleId}:`))
        : [key];
      for (const activeKey of keys) {
        const run = runs.current.get(activeKey);
        if (!run) continue;
        run.stopped = true;
        updateBatch(activeKey, { status: "stopping" });
      }
      if (keys.every((activeKey) => !runs.current.has(activeKey)))
        updateBatch(key, { status: "stopped" });
      const sourceById = new Map(details[titleId]?.title.sources?.map((source) => [source.id, source]));
      const currentJobIds = new Set(keys.map((activeKey) => runs.current.get(activeKey)?.currentJobId).filter((id): id is string => Boolean(id)));
      const activeJobs = jobsRef.current.filter((job) =>
        job.titleId === titleId &&
        job.state === "downloading" &&
        (seasonNumber === undefined ||
          currentJobIds.has(job.id) ||
          sourceById.get(job.sourceId)?.seasonNumber === seasonNumber),
      );
      for (const jobId of new Set([...currentJobIds, ...activeJobs.map((job) => job.id)]))
        void api.cancelOfflineDownload(profileId, jobId)
          .then(() => refresh())
          .catch((error) => showToast(safeErrorMessage(error), "error"));
      const stoppedKeys = new Set([...keys, key]);
      if (folderPromptRef.current && stoppedKeys.has(folderPromptRef.current.label)) {
        const promptKey = folderPromptRef.current.label;
        runs.current.delete(promptKey);
        updateBatch(promptKey, { status: "stopped" });
        folderPromptRef.current = null;
        setFolderPrompt(null);
      }
      if (batchPromptRef.current && stoppedKeys.has(batchPromptRef.current.key)) {
        const promptKey = batchPromptRef.current.key;
        runs.current.delete(promptKey);
        updateBatch(promptKey, { status: "stopped" });
        batchPromptRef.current = null;
        setBatchPrompt(null);
      }
    },
    [api, details, profileId, refresh, showToast, updateBatch],
  );

  const batchFor = useCallback(
    (title: CatalogTitle, seasonNumber?: number): DownloadBatchView => {
      const key = batchKey(title.id, seasonNumber);
      const entry = batches[key];
      const detail = details[title.id];
      const sources = [...(title.sources ?? []), ...(detail?.title.sources ?? [])];
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const availableEpisodes =
        detail?.series?.seasons
          .filter(
            (season) =>
              seasonNumber === undefined || season.seasonNumber === seasonNumber,
          )
          .flatMap((season) => season.episodes)
          .filter((episode) => episode.availability === "available") ?? [];
      const available = detail?.series
        ? availableEpisodes.length
        : seasonNumber === undefined
          ? title.seriesCoverage?.episodesAvailable ?? 0
          : 0;
      const availableKeys = new Set(availableEpisodes.map((episode) => episodeKey({
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
      })));
      const savedKeys = new Set(
        jobs
          .filter((job) => job.titleId === title.id && job.state === "complete")
          .map((job) => sourceById.get(job.sourceId))
          .filter(
            (source): source is TitleSource =>
              source !== undefined &&
              source.seasonNumber !== null &&
              source.episodeNumber !== null &&
              (seasonNumber === undefined ||
                source.seasonNumber === seasonNumber),
          )
          .map((source) =>
            episodeKey({
              seasonNumber: source.seasonNumber!,
              episodeNumber: source.episodeNumber!,
            }),
          ).filter((key) => !detail?.series || availableKeys.has(key)),
      );
      const activeJob = jobs.find((job) => {
        if (job.titleId !== title.id || job.state !== "downloading") return false;
        if (seasonNumber === undefined) return true;
        return sourceById.get(job.sourceId)?.seasonNumber === seasonNumber;
      });
      const active =
        entry?.status === "preparing" ||
        entry?.status === "confirming" ||
        entry?.status === "choosing-folder" ||
        entry?.status === "downloading" ||
        entry?.status === "stopping" ||
        activeJob !== undefined;
      const current = entry?.currentJobId
        ? jobs.find((job) => job.id === entry.currentJobId)
        : activeJob;
      const fraction =
        current?.totalBytes && current.totalBytes > 0
          ? Math.min(1, current.bytes / current.totalBytes)
          : 0;
      const progress = entry?.total
        ? Math.min(100, ((entry.processed + fraction) / entry.total) * 100)
        : current?.totalBytes
          ? Math.min(100, (current.bytes / current.totalBytes) * 100)
          : null;
      const complete = available > 0 && savedKeys.size >= available;
      const retry =
        !complete &&
        (savedKeys.size > 0 ||
          entry?.status === "partial" ||
          entry?.status === "failed" ||
          entry?.status === "stopped");
      return {
        action: active ? "stop" : complete ? "delete" : retry ? "retry" : "download",
        state: active ? "downloading" : complete ? "complete" : "idle",
        progress,
        entry,
        saved: savedKeys.size,
        available,
      };
    },
    [batches, details, jobs],
  );

  const startBatch = useCallback(
    async (title: CatalogTitle, seasonNumber?: number) => {
      const key = batchKey(title.id, seasonNumber);
      if (runs.current.has(key)) return;
      if (folderPromptRef.current || batchPromptRef.current) {
        showToast("Choose a folder for the pending download first.", "warning");
        return;
      }
      if ([...runs.current.keys()].some((activeKey) => activeKey.startsWith(`${title.id}:`))) {
        showToast("Another download for this series is already running.", "warning");
        return;
      }
      const run: BatchRun = { stopped: false };
      runs.current.set(key, run);
      createBatch({
        key,
        titleId: title.id,
        title: title.title,
        seasonNumber,
        status: "preparing",
        total: 0,
        processed: 0,
        failed: 0,
      });
      const finish = (status: DownloadBatch["status"], error?: string) => {
        updateBatch(key, {
          status,
          currentEpisode: undefined,
          currentJobId: undefined,
          error,
        });
        runs.current.delete(key);
      };
      try {
        let detail = await api.getTitleDetail(profileId, title.id);
        detail = await refreshMissingEpisodesForDownload(
          api,
          profileId,
          detail,
          seasonNumber,
          () => run.stopped,
        );
        setDetails((current) => ({ ...current, [title.id]: detail }));
        if (run.stopped) return finish("stopped");
        const episodes =
          detail.series?.seasons
            .filter(
              (season) =>
                seasonNumber === undefined || season.seasonNumber === seasonNumber,
            )
            .flatMap((season) => season.episodes)
            .filter((episode) => episode.availability === "available")
            .sort(
              (a, b) =>
                a.seasonNumber - b.seasonNumber ||
                a.episodeNumber - b.episodeNumber,
            ) ?? [];
        if (episodes.length === 0) {
          finish("failed", "There are no available episodes to download.");
          showToast("There are no available episodes to download.", "error");
          return;
        }
        updateBatch(key, { total: episodes.length });
        const knownJobs = await refresh();
        if (run.stopped) return finish("stopped");
        const pending = episodes.map((episode) => {
          const sources = (detail.title.sources ?? []).filter((source) =>
            downloadable(source) &&
            source.seasonNumber === episode.seasonNumber &&
            source.episodeNumber === episode.episodeNumber,
          );
          return { sources, episode };
        }).filter(({ sources }) => !sources.some((source) => knownJobs.some((job) =>
          job.titleId === title.id && job.sourceId === source.id && job.state === "complete",
        )));
        if (pending.length === 0) {
          finish("complete");
          showToast("All available episodes are already downloaded.", "info");
          return;
        }
        const sizes = pending.map(({ sources }) => sources[0]?.sizeBytes ?? null);
        const knownBytes = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
        const unknownSizes = sizes.filter((size) => size === null).length;
        const missingFromDetails =
          detail.series?.seasons
            .filter(
              (season) =>
                seasonNumber === undefined || season.seasonNumber === seasonNumber,
            )
            .flatMap((season) => season.episodes)
            .filter((episode) => episode.availability !== "available").length ?? 0;
        const coverage = detail.title.seriesCoverage;
        const missingCount =
          seasonNumber === undefined && coverage
            ? Math.max(
                missingFromDetails,
                coverage.episodesTotal - coverage.episodesAvailable,
              )
            : missingFromDetails;
        const roots = (await api.getLocalFolders()).roots;
        if (run.stopped) return finish("stopped");
        if (roots.length === 0) {
          const message = "Connect a Local folder in Settings before downloading.";
          finish("failed", message);
          showToast(message, "error");
          return;
        }
        const transfer = async (rootId: string) => {
          updateBatch(key, { status: "downloading" });
          let processed = 0;
          let failed = 0;
          try {
            let knownJobs = await refresh();
            for (const episode of episodes) {
              if (run.stopped) break;
              const selection = {
                seasonNumber: episode.seasonNumber,
                episodeNumber: episode.episodeNumber,
              };
              updateBatch(key, {
                currentEpisode: selection,
                currentJobId: undefined,
                processed,
                failed,
              });
              let sources = (detail.title.sources ?? []).filter(
                (source) =>
                  downloadable(source) &&
                  source.seasonNumber === selection.seasonNumber &&
                  source.episodeNumber === selection.episodeNumber,
              );
              if (sources.length === 0) {
                try {
                  const searched = await api.forceEpisodeSearch(
                    profileId,
                    title.id,
                    selection,
                  );
                  detail = searched.detail;
                  setDetails((current) => ({ ...current, [title.id]: detail }));
                  sources = searched.sources.filter(downloadable);
                } catch {
                  failed += 1;
                  processed += 1;
                  updateBatch(key, { processed, failed });
                  continue;
                }
              }
              if (run.stopped) break;
              if (sources.length === 0) {
                failed += 1;
                processed += 1;
                updateBatch(key, { processed, failed });
                continue;
              }
              const savedSource = sources.find((source) =>
                knownJobs.some(
                  (job) =>
                    job.titleId === title.id &&
                    job.sourceId === source.id &&
                    job.state === "complete",
                ),
              );
              if (savedSource) {
                processed += 1;
                updateBatch(key, { processed });
                continue;
              }
              const activeSource = sources.find((source) =>
                knownJobs.some(
                  (job) =>
                    job.titleId === title.id &&
                    job.sourceId === source.id &&
                    job.state === "downloading",
                ),
              );
              const source = activeSource ?? sources[0]!;
              let job = knownJobs.find(
                (candidate) =>
                  candidate.titleId === title.id &&
                  candidate.sourceId === source.id &&
                  candidate.state === "downloading",
              );
              if (!job) {
                try {
                  job = await api.startOfflineDownload(
                    profileId,
                    title.id,
                    source.id,
                    rootId,
                  );
                  knownJobs = [...knownJobs, job];
                  updateJobs(knownJobs);
                } catch {
                  failed += 1;
                  processed += 1;
                  updateBatch(key, { processed, failed });
                  continue;
                }
              }
              run.currentJobId = job.id;
              updateBatch(key, { currentJobId: job.id });
              if (run.stopped && job.state === "downloading")
                await api.cancelOfflineDownload(profileId, job.id);
              while (job.state === "downloading" && !run.stopped) {
                await pause(1000);
                knownJobs = await refresh();
                job = knownJobs.find((candidate) => candidate.id === job!.id) ?? {
                  ...job,
                  state: "failed",
                  error: "Download job disappeared.",
                };
              }
              run.currentJobId = undefined;
              if (run.stopped) break;
              if (job.state !== "complete") failed += 1;
              processed += 1;
              updateBatch(key, {
                processed,
                failed,
                currentJobId: undefined,
              });
            }
            if (run.stopped) finish("stopped");
            else {
              finish(failed === 0 ? "complete" : processed > failed ? "partial" : "failed");
              showToast(
                failed === 0
                  ? `Saved ${episodes.length} available episodes of ${title.title}.`
                  : `Saved ${processed - failed} of ${episodes.length} episodes of ${title.title}.`,
                failed === 0 ? "success" : "warning",
              );
            }
          } catch (error) {
            finish(run.stopped ? "stopped" : "failed", safeErrorMessage(error));
            if (!run.stopped) showToast(safeErrorMessage(error), "error");
          }
        };
        const begin = () => {
          if (run.stopped) return finish("stopped");
          if (roots.length > 1) {
            updateBatch(key, { status: "choosing-folder" });
            const prompt: FolderPrompt = {
              roots,
              rootId: roots[0]!.id,
              label: key,
              start: (rootId) => void transfer(rootId),
              cancel: () => stopBatch(title.id, seasonNumber),
            };
            folderPromptRef.current = prompt;
            setFolderPrompt(prompt);
          } else void transfer(roots[0]!.id);
        };
        updateBatch(key, { status: "confirming" });
        const prompt: BatchPrompt = {
          key,
          title: title.title,
          seasonNumber,
          count: pending.length,
          missingCount,
          knownBytes,
          unknownSizes,
          start: begin,
          cancel: () => stopBatch(title.id, seasonNumber),
        };
        batchPromptRef.current = prompt;
        setBatchPrompt(prompt);
      } catch (error) {
        finish(run.stopped ? "stopped" : "failed", safeErrorMessage(error));
        if (!run.stopped) showToast(safeErrorMessage(error), "error");
      }
    },
    [api, createBatch, profileId, refresh, showToast, stopBatch, updateBatch, updateJobs],
  );

  const movieFor = useCallback((title: CatalogTitle): DownloadBatchView => {
    const sources = [...(title.sources ?? []), ...(details[title.id]?.title.sources ?? [])]
      .filter(downloadable);
    const savedJobs = jobs.filter((job) => job.titleId === title.id && job.state === "complete");
    const activeJob = jobs.find((job) => job.titleId === title.id && job.state === "downloading");
    const saved = savedJobs.length > 0;
    const progress = activeJob?.totalBytes && activeJob.totalBytes > 0
      ? Math.min(100, activeJob.bytes / activeJob.totalBytes * 100) : null;
    const retry = jobs.some((job) => job.titleId === title.id && ["failed", "cancelled"].includes(job.state));
    return {
      action: activeJob ? "stop" : saved ? "delete" : retry ? "retry" : "download",
      state: activeJob ? "downloading" : saved ? "complete" : "idle",
      progress,
      saved: savedJobs.length,
      available: sources.length > 0 || saved ? 1 : 0,
      entry: activeJob ? { key: `${title.id}:movie`, titleId: title.id, title: title.title, status: "downloading", total: 1, processed: 0, failed: 0, currentJobId: activeJob.id } : undefined,
    };
  }, [details, jobs]);

  const confirmDelete = useCallback((selected: OfflineDownload[], label: string) => {
    const saved = selected.filter((job) => job.state === "complete");
    if (saved.length > 0) setDeletePrompt({ jobs: saved, label });
  }, []);
  const activateBatch = useCallback(
    (title: CatalogTitle, seasonNumber?: number) => {
      const view = batchFor(title, seasonNumber);
      if (view.action === "stop") {
        stopBatch(title.id, seasonNumber);
        return;
      }
      if (view.action === "delete") {
        const sourceById = new Map(
          [
            ...(title.sources ?? []),
            ...(details[title.id]?.title.sources ?? []),
          ].map((source) => [source.id, source]),
        );
        confirmDelete(
          jobsRef.current.filter(
            (job) =>
              job.titleId === title.id &&
              job.state === "complete" &&
              (seasonNumber === undefined ||
                sourceById.get(job.sourceId)?.seasonNumber === seasonNumber),
          ),
          seasonNumber === undefined
            ? title.title
            : `${title.title} · Season ${seasonNumber}`,
        );
        return;
      }
      void startBatch(title, seasonNumber);
    },
    [batchFor, confirmDelete, details, startBatch, stopBatch],
  );

  const stopSource = useCallback(
    async (jobId: string) => {
      const batch = [...runs.current.entries()].find(([, run]) => run.currentJobId === jobId);
      if (batch) {
        const [key, run] = batch;
        run.stopped = true;
        updateBatch(key, { status: "stopping" });
      }
      setStoppingJobIds((current) => current.includes(jobId) ? current : [...current, jobId]);
      try {
        await api.cancelOfflineDownload(profileId, jobId);
        await refresh();
      } catch (error) {
        setStoppingJobIds((current) => current.filter((id) => id !== jobId));
        throw error;
      }
    },
    [api, profileId, refresh, updateBatch],
  );
  const requestSource = useCallback(
    (title: CatalogTitle, source: TitleSource, replaceExisting = false) => {
      void (async () => {
        try {
          const roots = (await api.getLocalFolders()).roots;
          if (roots.length === 0) {
            showToast("Connect a Local folder in Settings before downloading.", "error");
            return;
          }
          if (folderPromptRef.current) {
            showToast("Choose a folder for the pending download first.", "warning");
            return;
          }
          const existingRootId = replaceExisting
            ? jobsRef.current.find((job) =>
                job.titleId === title.id && job.sourceId === source.id && job.state === "complete",
              )?.rootId
            : undefined;
          const defaultRootId = roots.find((root) => root.id === existingRootId)?.id ?? roots[0]!.id;
          const start = async (rootId: string) => {
            try {
              const job = await api.startOfflineDownload(
                profileId,
                title.id,
                source.id,
                rootId,
                replaceExisting,
              );
              updateJobs([...jobsRef.current, job]);
            } catch (error) {
              showToast(safeErrorMessage(error), "error");
            }
          };
          if (roots.length > 1) {
            const prompt: FolderPrompt = {
              roots,
              rootId: defaultRootId,
              label: source.releaseName,
              start: (rootId) => void start(rootId),
              cancel: () => undefined,
            };
            folderPromptRef.current = prompt;
            setFolderPrompt(prompt);
          } else void start(defaultRootId);
        } catch (error) {
          showToast(safeErrorMessage(error), "error");
        }
      })();
    },
    [api, profileId, showToast, updateJobs],
  );
  const activateMovie = useCallback((title: CatalogTitle) => {
    const view = movieFor(title);
    const savedJobs = jobsRef.current.filter((job) => job.titleId === title.id && job.state === "complete");
    if (view.action === "stop") {
      const active = jobsRef.current.find((job) => job.titleId === title.id && job.state === "downloading");
      if (active) void stopSource(active.id).catch((error) => showToast(safeErrorMessage(error), "error"));
      return;
    }
    if (view.action === "delete") {
      confirmDelete(savedJobs, title.title);
      return;
    }
    void (async () => {
      try {
        let detail = details[title.id] ?? await api.getTitleDetail(profileId, title.id);
        let source = detail.title.sources?.find(downloadable);
        if (!source) {
          const searched = await api.forceTitleSearch(profileId, title.id);
          detail = searched.detail;
          source = detail.title.sources?.find(downloadable);
        }
        setDetails((current) => ({ ...current, [title.id]: detail }));
        if (!source) {
          showToast("No downloadable source is available for this movie.", "error");
          return;
        }
        requestSource(detail.title, source);
      } catch (error) {
        showToast(safeErrorMessage(error), "error");
      }
    })();
  }, [api, confirmDelete, details, movieFor, profileId, requestSource, showToast, stopSource]);
  const findSources = useCallback(
    async (title: CatalogTitle, episode?: EpisodeSelection) => {
      const response = episode
        ? await api.forceEpisodeSearch(profileId, title.id, episode)
        : await api.forceTitleSearch(profileId, title.id);
      setDetails((current) => ({ ...current, [title.id]: response.detail }));
    },
    [api, profileId],
  );
  const loadDetail = useCallback(async (titleId: string) => {
    const response = await api.getTitleDetail(profileId, titleId);
    setDetails((current) => ({ ...current, [titleId]: response }));
    return response;
  }, [api, profileId]);

  return (
    <DownloadContext.Provider
      value={{
        jobs,
        batches,
        details,
        libraryRevision,
        stoppingJobIds,
        refresh,
        batchFor,
        movieFor,
        activateBatch,
        activateMovie,
        stopBatch,
        requestSource,
        stopSource,
        confirmDelete,
        findSources,
        loadDetail,
      }}
    >
      {children}
      {batchPrompt && (
        <div className="download-modal-backdrop">
          <div className="download-modal" role="dialog" aria-modal="true" aria-label="Confirm series download">
            <h2>Download {batchPrompt.seasonNumber == null ? "series" : `Season ${batchPrompt.seasonNumber}`}?</h2>
            <p className="download-modal__title">{batchPrompt.title}</p>
            <dl className="download-modal__summary">
              <div><dt>Files</dt><dd>{batchPrompt.count} {batchPrompt.count === 1 ? "episode" : "episodes"}</dd></div>
              <div><dt>Estimated size</dt><dd>{batchPrompt.knownBytes > 0 ? formatDownloadSize(batchPrompt.knownBytes) : "Unknown"}{batchPrompt.unknownSizes > 0 && batchPrompt.knownBytes > 0 ? " + unknown size" : ""}</dd></div>
            </dl>
            {batchPrompt.missingCount > 0 && <p className="download-modal__note">{batchPrompt.missingCount} {batchPrompt.missingCount === 1 ? "episode is" : "episodes are"} currently unavailable and will be skipped.</p>}
            {batchPrompt.unknownSizes > 0 && <p className="download-modal__note">Size is unavailable for {batchPrompt.unknownSizes} {batchPrompt.unknownSizes === 1 ? "file" : "files"}. The final download may use more space.</p>}
            <div className="download-modal__actions">
              <button type="button" className="button button--secondary" onClick={() => {
                batchPrompt.cancel();
                batchPromptRef.current = null;
                setBatchPrompt(null);
              }}>Cancel</button>
              <button type="button" className="button button--primary" onClick={() => {
                batchPromptRef.current = null;
                setBatchPrompt(null);
                batchPrompt.start();
              }}>Download {batchPrompt.count} {batchPrompt.count === 1 ? "file" : "files"}</button>
            </div>
          </div>
        </div>
      )}
      {folderPrompt && (
        <div className="download-modal-backdrop">
          <div className="download-modal" role="dialog" aria-modal="true" aria-label="Choose download folder">
            <h2>Choose download folder</h2>
            <label>
              Folder
              <select
                value={folderPrompt.rootId}
                onChange={(event) =>
                  setFolderPrompt((prompt) =>
                    prompt ? { ...prompt, rootId: event.target.value } : null,
                  )
                }
              >
                {folderPrompt.roots.map((root) => (
                  <option key={root.id} value={root.id}>{root.path}</option>
                ))}
              </select>
            </label>
            <div className="download-modal__actions">
              <button type="button" className="button button--secondary" onClick={() => {
                folderPrompt.cancel();
                folderPromptRef.current = null;
                setFolderPrompt(null);
              }}>Cancel</button>
              <button type="button" className="button button--primary" onClick={() => {
                folderPrompt.start(folderPrompt.rootId);
                folderPromptRef.current = null;
                setFolderPrompt(null);
              }}>Start download</button>
            </div>
          </div>
        </div>
      )}
      {deletePrompt && (
        <div className="download-modal-backdrop">
          <div className="download-modal" role="dialog" aria-modal="true" aria-label="Delete offline files">
            <h2>Delete offline files?</h2>
            <p>This permanently deletes {deletePrompt.jobs.length} downloaded {deletePrompt.jobs.length === 1 ? "file" : "files"} for {deletePrompt.label}.</p>
            <div className="download-modal__actions">
              <button type="button" className="button button--secondary" onClick={() => setDeletePrompt(null)}>Cancel</button>
              <button type="button" className="button button--danger" disabled={deleting} onClick={() => {
                const selection = deletePrompt;
                setDeleting(true);
                void (async () => {
                  try {
                    for (const job of selection.jobs)
                      await (api.deleteOfflineDownload ?? api.cancelOfflineDownload)(profileId, job.id);
                    await refresh();
                    showToast("Offline files deleted.", "success");
                    setDeletePrompt(null);
                  } catch (error) {
                    showToast(safeErrorMessage(error), "error");
                    await refresh().catch(() => undefined);
                  } finally {
                    setDeleting(false);
                  }
                })();
              }}>Delete files</button>
            </div>
          </div>
        </div>
      )}
    </DownloadContext.Provider>
  );
}
