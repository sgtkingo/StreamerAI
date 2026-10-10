import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import type { StreamerDatabase } from "@streamer-ai/database";
import { WebshareClient } from "../integrations/webshare-client.js";
import { validatePlaybackSourceUrl } from "./playback-ticket-store.js";
import {
  LOCAL_MEDIA_EXTENSIONS,
  LocalMediaLibrary,
} from "./local-media-library.js";
import { PreferredSourceStore } from "./preferred-source-store.js";

export interface OfflineDownload {
  id: string;
  profileId: string;
  titleId: string;
  sourceId: string;
  rootId: string;
  state: "downloading" | "complete" | "failed" | "cancelled";
  bytes: number;
  totalBytes: number | null;
  error: string | null;
}

const MAX_BYTES = 30 * 1024 * 1024 * 1024;
const SAVED_KEY = "local-files.saved-downloads";
interface SavedDownload {
  job: OfflineDownload;
  target: string;
  candidateId: string;
}
const savedKey = (
  job: Pick<OfflineDownload, "profileId" | "titleId" | "sourceId" | "rootId">,
) => JSON.stringify([job.profileId, job.titleId, job.sourceId, job.rootId]);
const safeName = (name: string) =>
  [...name]
    .map((character) =>
      character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character)
        ? "_"
        : character,
    )
    .join("")
    .replace(/^\.+/, "")
    .slice(0, 180);

export class OfflineDownloadManager {
  private jobs = new Map<string, OfflineDownload>();
  private controllers = new Map<string, AbortController>();
  private running = new Map<string, Promise<void>>();
  private saved = new Map<string, SavedDownload>();
  private preferred: PreferredSourceStore;

  constructor(
    private readonly database: StreamerDatabase,
    private readonly local: LocalMediaLibrary,
    private readonly webshare: WebshareClient,
    private readonly fetchSource: typeof fetch = globalThis.fetch,
  ) {
    this.preferred = new PreferredSourceStore(database);
    for (const record of database.settings.get<SavedDownload[]>(SAVED_KEY) ??
      [])
      if (
        record?.job?.state === "complete" &&
        typeof record.target === "string"
      )
        this.saved.set(savedKey(record.job), record);
  }

  list(profileId: string): OfflineDownload[] {
    const entries = [
      ...[...this.saved.values()].map((item) => item.job),
      ...this.jobs.values(),
    ];
    return [...new Map(entries.map((job) => [job.id, job])).values()]
      .filter((job) => job.profileId === profileId)
      .map((job) => ({ ...job }));
  }

  start(input: {
    profileId: string;
    titleId: string;
    sourceId: string;
    rootId: string;
    replaceExisting?: boolean;
  }): OfflineDownload {
    if (!this.database.profiles.get(input.profileId))
      throw new Error("Profile not found.");
    const title = this.database.titles.get(input.titleId);
    const source = title?.sources?.find((item) => item.id === input.sourceId);
    if (!source || source.providerId !== "webshare")
      throw new Error("Choose a Webshare source to save offline.");
    if (!this.local.getRoot(input.rootId))
      throw new Error("Choose a connected destination folder.");
    const existing = this.saved.get(savedKey(input));
    if (existing && !input.replaceExisting)
      throw new Error(
        "This source is already saved offline. Confirm replacement to download it again.",
      );
    if (
      [...this.jobs.values()].some(
        (job) =>
          job.state === "downloading" && savedKey(job) === savedKey(input),
      )
    )
      throw new Error("This source is already downloading.");
    const ext = extname(source.releaseName).slice(1).toLowerCase();
    if (
      !LOCAL_MEDIA_EXTENSIONS.includes(
        ext as (typeof LOCAL_MEDIA_EXTENSIONS)[number],
      )
    )
      throw new Error("This source has an unsupported video format.");
    const id = randomUUID();
    const job: OfflineDownload = {
      id,
      profileId: input.profileId,
      titleId: input.titleId,
      sourceId: input.sourceId,
      rootId: input.rootId,
      state: "downloading",
      bytes: 0,
      totalBytes: source.sizeBytes,
      error: null,
    };
    this.jobs.set(id, job);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const task = this.transfer(
      job,
      source.candidateId,
      source.releaseName,
      source.seasonNumber !== null && source.episodeNumber !== null
        ? {
            seasonNumber: source.seasonNumber,
            episodeNumber: source.episodeNumber,
          }
        : undefined,
      controller.signal,
      existing,
    )
      .catch((error: unknown) => {
        job.state = controller.signal.aborted ? "cancelled" : "failed";
        job.error = controller.signal.aborted
          ? null
          : error instanceof Error
            ? error.message
            : "Download failed.";
      })
      .finally(() => {
        this.controllers.delete(id);
        this.running.delete(id);
      });
    this.running.set(id, task);
    return { ...job };
  }

  cancel(id: string, profileId: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.profileId !== profileId || job.state !== "downloading")
      return false;
    this.controllers.get(id)?.abort();
    return true;
  }

  cancelRoot(rootId: string): void {
    for (const job of this.jobs.values())
      if (job.rootId === rootId && job.state === "downloading")
        this.controllers.get(job.id)?.abort();
  }

  forgetRoot(rootId: string): void {
    for (const [key, record] of this.saved)
      if (record.job.rootId === rootId) this.saved.delete(key);
    this.database.settings.set(SAVED_KEY, [...this.saved.values()]);
  }

  async close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.all(this.running.values());
  }

  private async transfer(
    job: OfflineDownload,
    candidateId: string,
    filename: string,
    selectedEpisode: { seasonNumber: number; episodeNumber: number } | undefined,
    signal: AbortSignal,
    existing?: SavedDownload,
  ): Promise<void> {
    const root = this.local.getRoot(job.rootId);
    if (!root || (await realpath(root.path)) !== root.path)
      throw new Error("Destination folder is unavailable.");
    const folder = join(root.path, ".streamerai-downloads");
    await mkdir(folder, { recursive: true });
    if ((await realpath(folder)) !== folder)
      throw new Error("Destination folder changed while preparing download.");
    const name = safeName(filename);
    if (!name) throw new Error("Source filename is invalid.");
    if (existing) {
      const resolved = await this.local.resolveFile(existing.candidateId);
      const part = relative(folder, existing.target);
      if (
        resolved.path !== existing.target ||
        resolved.rootId !== job.rootId ||
        part === ".." ||
        part.startsWith(`..${sep}`) ||
        isAbsolute(part)
      )
        throw new Error(
          "The saved offline file is no longer in its managed folder.",
        );
    }
    const jobFolder = existing
      ? dirname(existing.target)
      : join(folder, job.id);
    if (!existing) await mkdir(jobFolder);
    const target = existing?.target ?? join(jobFolder, name);
    const temporary = `${target}.part-${job.id}`;
    let downloaded = false;
    try {
      const url = validatePlaybackSourceUrl(
        await this.webshare.createVideoLink(candidateId),
      );
      const response = await this.fetchSource(url, {
        method: "GET",
        redirect: "error",
        signal,
      });
      if (!response.ok || !response.body)
        throw new Error(
          "The streaming source did not provide a downloadable file.",
        );
      const stated = Number(response.headers.get("content-length"));
      if (Number.isFinite(stated) && stated > MAX_BYTES)
        throw new Error("File exceeds the 30 GB offline limit.");
      job.totalBytes =
        Number.isFinite(stated) && stated > 0 ? stated : job.totalBytes;
      const output = await open(temporary, "wx");
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          const buffer = Buffer.from(chunk);
          job.bytes += buffer.length;
          if (job.bytes > MAX_BYTES)
            throw new Error("File exceeds the 30 GB offline limit.");
          await output.writeFile(buffer);
        }
        await output.sync();
        signal.throwIfAborted();
        if (job.bytes === 0) throw new Error("Downloaded file is empty.");
        if (Number.isFinite(stated) && stated > 0 && job.bytes !== stated)
          throw new Error("The download ended before the file was complete.");
      } catch (error) {
        await output.close();
        await rm(temporary, { force: true });
        throw error;
      }
      await output.close();
      await rename(temporary, target);
      downloaded = true;
      await this.local.linkManagedFile(target, job.titleId, selectedEpisode);
      this.local.startScan();
      await this.local.waitForScan();
      signal.throwIfAborted();
      if (this.local.getConfig().scan.state === "failed")
        throw new Error(
          "The file was saved, but the local library scan failed.",
        );
      const indexed = this.local
        .allFiles()
        .find((file) => file.path === target && file.rootId === job.rootId);
      const title = this.database.titles.get(job.titleId);
      const localSource = title?.sources?.find(
        (source) =>
          source.providerId === "local-files" &&
          source.candidateId === indexed?.id,
      );
      if (!indexed || !localSource)
        throw new Error("The saved file was not indexed in Library.");
      job.state = "complete";
      this.saved.set(savedKey(job), {
        job: { ...job },
        target,
        candidateId: indexed.id,
      });
      this.database.settings.set(SAVED_KEY, [...this.saved.values()]);
      const remote = title?.sources?.find(
        (source) => source.id === job.sourceId,
      );
      const episode =
        remote?.seasonNumber !== null &&
        remote?.episodeNumber !== null &&
        remote?.seasonNumber !== undefined &&
        remote?.episodeNumber !== undefined
          ? {
              seasonNumber: remote.seasonNumber,
              episodeNumber: remote.episodeNumber,
            }
          : undefined;
      this.preferred.set(job.profileId, job.titleId, localSource.id, episode);
    } catch (error) {
      await rm(temporary, { force: true });
      if (!existing) {
        this.local.unlinkManagedFile(target);
        await rm(jobFolder, { recursive: true, force: true });
        if (downloaded) {
          this.local.startScan();
          await this.local.waitForScan();
        }
      }
      throw error;
    }
  }
}
