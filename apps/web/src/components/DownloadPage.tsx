import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CatalogTitle, EpisodeSelection, TitleSource } from "@streamer-ai/contracts";
import type { OfflineDownload } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { DownloadButton, DownloadGlyph, TrashGlyph } from "./DownloadButton";
import { useDownloadManager } from "./DownloadManager";
import { formatDownloadSize } from "./download-size";
import { useToasts } from "./ToastProvider";

const canDownload = (source: TitleSource) =>
  source.providerId === "webshare" &&
  /\.(mkv|avi|mp4|m4v|mov|webm|mpg|mpeg|ts|m2ts)$/i.test(source.releaseName);

function episodeCode(source: TitleSource) {
  return source.seasonNumber != null && source.episodeNumber != null
    ? `S${String(source.seasonNumber).padStart(2, "0")}E${String(source.episodeNumber).padStart(2, "0")}`
    : "Movie";
}

function RetryGlyph() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 11a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
    <path d="M12 8v7m-3-3 3 3 3-3" />
  </svg>;
}

function MoreGlyph() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
  </svg>;
}

function IconAction({
  label, onClick, children, tone, expanded, disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  tone?: "danger";
  expanded?: boolean;
  disabled?: boolean;
}) {
  return <button
    className={`downloads-icon-button${tone ? ` downloads-icon-button--${tone}` : ""}`}
    type="button"
    aria-label={label}
    aria-expanded={expanded}
    title={label}
    disabled={disabled}
    onClick={onClick}
  >{children}</button>;
}

export function DownloadPage({ onOpenTitle }: {
  onOpenTitle: (title: CatalogTitle) => void;
}) {
  const manager = useDownloadManager();
  const { showToast } = useToasts();
  const requested = useRef(new Set<string>());
  const [openSourcesFor, setOpenSourcesFor] = useState<string | null>(null);
  const [searchingFor, setSearchingFor] = useState<string | null>(null);
  const [pendingStops, setPendingStops] = useState<Set<string>>(new Set());
  const jobs = manager?.jobs ?? [];
  const batches = useMemo(() => Object.values(manager?.batches ?? {}), [manager?.batches]);
  const titleIds = useMemo(() => [...new Set([
    ...jobs.map((job) => job.titleId),
    ...batches.map((batch) => batch.titleId),
  ])], [jobs, batches]);

  useEffect(() => {
    if (!manager) return;
    for (const titleId of titleIds) {
      if (manager.details[titleId] || requested.current.has(titleId)) continue;
      requested.current.add(titleId);
      void manager.loadDetail(titleId).catch((error) => {
        requested.current.delete(titleId);
        showToast(safeErrorMessage(error), "error");
      });
    }
  }, [manager, titleIds, showToast]);

  useEffect(() => {
    setPendingStops((current) => {
      const next = new Set([...current].filter((id) => jobs.some((job) => job.id === id && job.state === "downloading")));
      return next.size === current.size ? current : next;
    });
  }, [jobs]);

  useEffect(() => {
    if (!openSourcesFor) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenSourcesFor(null);
    };
    const closeOutside = (event: PointerEvent) => {
      const block = event.target instanceof Element
        ? event.target.closest("[data-source-menu-id]") : null;
      if (block?.getAttribute("data-source-menu-id") !== openSourcesFor)
        setOpenSourcesFor(null);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", closeOutside);
    };
  }, [openSourcesFor]);

  const activeBatches = batches.filter((batch) =>
    ["preparing", "confirming", "choosing-folder", "downloading", "stopping"].includes(batch.status),
  );
  const batchJobIds = new Set(activeBatches.map((batch) => batch.currentJobId));
  const individualJobs = jobs.filter((job) => job.state === "downloading" && !batchJobIds.has(job.id));
  const savedJobs = jobs.filter((job) => job.state === "complete");
  const savedGroups = titleIds.map((titleId) => ({
    titleId,
    detail: manager?.details[titleId],
    items: savedJobs.filter((job) => job.titleId === titleId),
  })).filter((group) => group.items.length > 0);
  const totalBytes = savedJobs.reduce((sum, job) => sum + job.bytes, 0);
  const movieBytes = savedJobs.filter((job) => manager?.details[job.titleId]?.title.kind === "movie")
    .reduce((sum, job) => sum + job.bytes, 0);
  const seriesBytes = savedJobs.filter((job) => manager?.details[job.titleId]?.title.kind === "series")
    .reduce((sum, job) => sum + job.bytes, 0);
  const otherBytes = Math.max(0, totalBytes - movieBytes - seriesBytes);
  const sourceFor = (job: OfflineDownload) =>
    manager?.details[job.titleId]?.title.sources?.find((source) => source.id === job.sourceId);

  const stopIndividual = (jobId: string) => {
    if (!manager || pendingStops.has(jobId)) return;
    setPendingStops((current) => new Set(current).add(jobId));
    void manager.stopSource(jobId).catch((error) => {
      setPendingStops((current) => {
        const next = new Set(current);
        next.delete(jobId);
        return next;
      });
      showToast(safeErrorMessage(error), "error");
    });
  };

  const searchForMore = async (title: CatalogTitle, episode: EpisodeSelection | undefined, jobId: string) => {
    if (!manager) return;
    setSearchingFor(jobId);
    try {
      await manager.findSources(title, episode);
      showToast("Source search finished.", "success");
    } catch (error) {
      showToast(safeErrorMessage(error), "error");
    } finally {
      setSearchingFor(null);
    }
  };

  return <main className="downloads-page">
    <div className="downloads-page__header">
      <div>
        <p className="downloads-page__eyebrow">Local library</p>
        <h1>Downloads</h1>
        <p>Manage transfers, saved files, and additional sources.</p>
      </div>
      <span className="downloads-page__count">{savedJobs.length} saved {savedJobs.length === 1 ? "file" : "files"}</span>
    </div>

    <section className="downloads-storage" aria-label="Downloaded storage use">
      <div className="downloads-storage__heading"><span>Downloaded storage</span><strong>{formatDownloadSize(totalBytes)}</strong></div>
      <div className="downloads-storage__bar" role="img" aria-label={`Movies ${formatDownloadSize(movieBytes)}, series ${formatDownloadSize(seriesBytes)}${otherBytes ? `, uncategorized ${formatDownloadSize(otherBytes)}` : ""}`}>
        {totalBytes > 0 && <>
          <span className="downloads-storage__segment downloads-storage__segment--movies" style={{ width: `${movieBytes / totalBytes * 100}%` }} />
          <span className="downloads-storage__segment downloads-storage__segment--series" style={{ width: `${seriesBytes / totalBytes * 100}%` }} />
          {otherBytes > 0 && <span className="downloads-storage__segment downloads-storage__segment--other" style={{ width: `${otherBytes / totalBytes * 100}%` }} />}
        </>}
      </div>
      <div className="downloads-storage__legend">
        <span><i className="downloads-storage__dot downloads-storage__dot--movies" />Movies <strong>{formatDownloadSize(movieBytes)}</strong></span>
        <span><i className="downloads-storage__dot downloads-storage__dot--series" />Series <strong>{formatDownloadSize(seriesBytes)}</strong></span>
        {otherBytes > 0 && <span><i className="downloads-storage__dot downloads-storage__dot--other" />Other <strong>{formatDownloadSize(otherBytes)}</strong></span>}
      </div>
    </section>

    <section className="downloads-panel" aria-label="Current downloads">
      <div className="downloads-panel__heading"><h2>Current downloads</h2><span>{activeBatches.length + individualJobs.length} active</span></div>
      {activeBatches.length === 0 && individualJobs.length === 0 && <p className="downloads-empty">Nothing is downloading right now.</p>}
      {activeBatches.map((batch) => {
        const title = manager?.details[batch.titleId]?.title;
        const view = title && manager?.batchFor(title, batch.seasonNumber);
        const current = jobs.find((job) => job.id === batch.currentJobId);
        const status = batch.status === "confirming" ? "Waiting for confirmation"
          : batch.status === "choosing-folder" ? "Choose a folder to start"
          : batch.status === "stopping" ? "Stopping…"
          : batch.currentEpisode ? `Downloading S${String(batch.currentEpisode.seasonNumber).padStart(2, "0")}E${String(batch.currentEpisode.episodeNumber).padStart(2, "0")}`
          : "Preparing…";
        return <div className="downloads-transfer" key={batch.key}>
          <div className="downloads-transfer__heading">
            <div><strong>{batch.title}{batch.seasonNumber == null ? "" : ` · Season ${batch.seasonNumber}`}</strong>
              <p>{status} · {batch.processed} of {batch.total} episodes{current?.totalBytes ? ` · ${formatDownloadSize(current.bytes)} / ${formatDownloadSize(current.totalBytes)}` : ""}</p></div>
            <DownloadButton state="downloading" progress={view?.progress ?? null} pending={batch.status === "stopping"} stopLabel="Stop" label={batch.title} onClick={() => manager?.stopBatch(batch.titleId, batch.seasonNumber)} />
          </div>
          <div className="downloads-progress" role="progressbar" aria-label={`${batch.title} download progress`} aria-valuenow={Math.round(view?.progress ?? 0)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${view?.progress ?? 0}%` }} /></div>
        </div>;
      })}
      {individualJobs.map((job) => {
        const title = manager?.details[job.titleId]?.title;
        const source = sourceFor(job);
        const percent = job.totalBytes ? Math.min(100, job.bytes / job.totalBytes * 100) : 0;
        return <div className="downloads-transfer" key={job.id}>
          <div className="downloads-transfer__heading">
            <div><strong>{title?.title ?? job.titleId} · {source ? episodeCode(source) : "Source"}</strong>
              <p>{source?.releaseName ?? job.sourceId} · {formatDownloadSize(job.bytes)}{job.totalBytes ? ` / ${formatDownloadSize(job.totalBytes)}` : ""}</p></div>
            <DownloadButton state="downloading" progress={job.totalBytes ? percent : null} pending={pendingStops.has(job.id)} stopLabel="Stop" label={source?.releaseName ?? title?.title ?? "download"} onClick={() => stopIndividual(job.id)} />
          </div>
          <div className="downloads-progress" role="progressbar" aria-label="Download progress" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>
        </div>;
      })}
    </section>

    <section className="downloads-library" aria-label="Saved files">
      <h2>Saved files</h2>
      {savedGroups.length === 0 && <p className="downloads-empty">No local files yet. Download a movie or an episode to see it here.</p>}
      {savedGroups.map(({ titleId, detail, items }) => {
        const title = detail?.title;
        const sourceById = new Map(title?.sources?.map((source) => [source.id, source]) ?? []);
        const savedSourceIds = new Set(items.map((job) => job.sourceId));
        const groupBytes = items.reduce((sum, job) => sum + job.bytes, 0);
        return <article className="downloads-title" key={titleId}>
          <div className="downloads-title__heading">
            <div><h3>{title?.title ?? titleId}</h3><p>{items.length} saved {items.length === 1 ? "file" : "files"} · {formatDownloadSize(groupBytes)}</p></div>
            <div className="downloads-file__actions">
              {title && <button className="button button--secondary button--compact" type="button" onClick={() => onOpenTitle(title)}>Details</button>}
              <IconAction label={`Delete all saved files of ${title?.title ?? titleId}`} tone="danger" onClick={() => manager?.confirmDelete(items, title?.title ?? titleId)}><TrashGlyph /></IconAction>
            </div>
          </div>
          <div className="downloads-title__files">
            {items.map((job) => {
              const source = sourceById.get(job.sourceId);
              const episode = source?.seasonNumber != null && source.episodeNumber != null
                ? { seasonNumber: source.seasonNumber, episodeNumber: source.episodeNumber } : undefined;
              const alternatives = (title?.sources ?? []).filter(canDownload).filter((candidate) =>
                title?.kind !== "series" || (episode != null && candidate.seasonNumber === episode.seasonNumber && candidate.episodeNumber === episode.episodeNumber),
              ).filter((candidate) => !savedSourceIds.has(candidate.id));
              const open = openSourcesFor === job.id;
              return <div className="downloads-file-block" data-source-menu-id={job.id} key={job.id}>
                <div className="downloads-file">
                  <div><strong>{source ? episodeCode(source) : "Saved source"}</strong><span>{source?.releaseName ?? job.sourceId}</span><small>{formatDownloadSize(job.bytes)}</small></div>
                  <div className="downloads-file__actions">
                    {title && source && <IconAction label={`Download ${source.releaseName} again`} disabled={jobs.some((active) => active.titleId === titleId && active.sourceId === source.id && active.state === "downloading")} onClick={() => manager?.requestSource(title, source, true)}><RetryGlyph /></IconAction>}
                    <IconAction label={`Delete ${source?.releaseName ?? job.sourceId}`} tone="danger" onClick={() => manager?.confirmDelete([job], source?.releaseName ?? title?.title ?? "file")}><TrashGlyph /></IconAction>
                    <IconAction label={`More sources for ${source ? episodeCode(source) : title?.title ?? titleId}`} expanded={open} onClick={() => setOpenSourcesFor(open ? null : job.id)}><MoreGlyph /></IconAction>
                  </div>
                </div>
                {open && <div className="downloads-source-menu" aria-label="More sources">
                  <div className="downloads-source-menu__heading"><strong>More sources {source ? `· ${episodeCode(source)}` : ""}</strong>
                    <button className="button button--secondary button--compact" type="button" disabled={!title || searchingFor === job.id} onClick={() => title && void searchForMore(title, episode, job.id)}>{searchingFor === job.id ? "Searching…" : "Find more sources"}</button>
                  </div>
                  {alternatives.length === 0 ? <p className="downloads-empty">No additional source is available yet.</p>
                    : alternatives.slice(0, 10).map((candidate) => <div className="downloads-source" key={candidate.id}>
                      <span>{candidate.releaseName}<small>{candidate.sizeBytes == null ? "Size unknown" : formatDownloadSize(candidate.sizeBytes)}</small></span>
                      <IconAction label={`Download ${candidate.releaseName}`} disabled={jobs.some((active) => active.titleId === titleId && active.sourceId === candidate.id && active.state === "downloading")} onClick={() => title && manager?.requestSource(title, candidate)}><DownloadGlyph /></IconAction>
                    </div>)}
                  {alternatives.length > 10 && <p className="downloads-empty">Showing 10 of {alternatives.length} sources.</p>}
                </div>}
              </div>;
            })}
          </div>
        </article>;
      })}
    </section>
  </main>;
}
