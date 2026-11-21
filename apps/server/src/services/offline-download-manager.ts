import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import type { StreamerDatabase } from "@streamer-ai/database";
import { WebshareClient } from "../integrations/webshare-client.js";
import { validatePlaybackSourceUrl } from "./playback-ticket-store.js";
import {
  LOCAL_MEDIA_EXTENSIONS,
  LocalMediaLibrary,
} from "./local-media-library.js";
import { PreferredSourceStore } from "./preferred-source-store.js";
import { directSourceId, directTitleId } from "./direct-search.js";

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
  /** Fast Search downloads: the file name (they have no catalog title). */
  label?: string;
  direct?: boolean;
}

const MAX_BYTES = 30 * 1024 * 1024 * 1024;
/** Fast Search files are saved here, under their original names. */
export const DIRECT_FOLDER = "Fast Search";
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
    const savedIds = new Set(
      [...this.saved.values()].map((item) => item.job.id),
    );
    const entries = [
      ...[...this.saved.values()].map((item) => item.job),
      ...[...this.jobs.values()].filter(
        (job) => job.state !== "complete" || savedIds.has(job.id),
      ),
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

  /** Saves a Fast Search file (Webshare) into the root's "Fast Search" folder. */
  async startDirect(input: {
    profileId: string;
    candidateId: string;
    rootId: string;
    replaceExisting?: boolean;
  }): Promise<OfflineDownload> {
    if (!this.database.profiles.get(input.profileId))
      throw new Error("Profile not found.");
    if (!this.local.getRoot(input.rootId))
      throw new Error("Choose a connected destination folder.");
    const ref = { providerId: "webshare", candidateId: input.candidateId };
    const key = {
      profileId: input.profileId,
      titleId: directTitleId(ref),
      sourceId: directSourceId(ref),
      rootId: input.rootId,
    };
    const existing = this.saved.get(savedKey(key));
    if (existing && !input.replaceExisting)
      throw new Error(
        "This file is already saved offline. Confirm replacement to download it again.",
      );
    if (
      [...this.jobs.values()].some(
        (job) => job.state === "downloading" && savedKey(job) === savedKey(key),
      )
    )
      throw new Error("This file is already downloading.");
    const file = await this.webshare
      .forProfile(input.profileId)
      .fileInfo(input.candidateId);
    if (!file.downloadable || file.passwordProtected)
      throw new Error("Webshare does not allow downloading this file.");
    const ext = extname(file.name).slice(1).toLowerCase();
    if (
      !LOCAL_MEDIA_EXTENSIONS.includes(
        ext as (typeof LOCAL_MEDIA_EXTENSIONS)[number],
      )
    )
      throw new Error("This file has an unsupported video format.");
    const id = randomUUID();
    const job: OfflineDownload = {
      id,
      ...key,
      state: "downloading",
      bytes: 0,
      totalBytes: file.size,
      error: null,
      label: file.name,
      direct: true,
    };
    this.jobs.set(id, job);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const task = this.transferDirect(
      job,
      input.candidateId,
      file.name,
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

  async removeSaved(id: string, profileId: string): Promise<boolean> {
    const entry = [...this.saved.entries()].find(
      ([, record]) =>
        record.job.id === id && record.job.profileId === profileId,
    );
    if (!entry) return false;
    const [key, record] = entry;
    if (
      [...this.jobs.values()].some(
        (job) => job.state === "downloading" && savedKey(job) === key,
      )
    )
      throw new Error("Wait for the replacement download to finish first.");
    if (record.job.direct) return this.removeDirect(key, record);

    const root = this.local.getRoot(record.job.rootId);
    if (!root || (await realpath(root.path)) !== root.path)
      throw new Error("The saved file's destination folder is unavailable.");
    const managedFolder = join(root.path, ".streamerai-downloads");
    if ((await realpath(managedFolder)) !== managedFolder)
      throw new Error("The managed download folder has changed.");
    const targetFolder = dirname(record.target);
    const folderPart = relative(managedFolder, targetFolder);
    if (
      !folderPart ||
      folderPart === ".." ||
      folderPart.startsWith(`..${sep}`) ||
      isAbsolute(folderPart) ||
      dirname(targetFolder) !== managedFolder
    )
      throw new Error("The saved file is outside the managed download folder.");
    try {
      if ((await realpath(targetFolder)) !== targetFolder)
        throw new Error("The saved file's folder has changed.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const indexed = this.local.getFile(record.candidateId);
    if (
      indexed &&
      (indexed.path !== record.target || indexed.rootId !== record.job.rootId)
    )
      throw new Error("The saved file no longer matches its library entry.");
    try {
      if ((await realpath(record.target)) !== record.target)
        throw new Error("The saved file has been moved outside its folder.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await rm(record.target, { force: true });
    try {
      await rmdir(targetFolder);
    } catch {
      // Keep the managed folder when it still contains other files.
    }
    this.local.unlinkManagedFile(record.target);
    this.saved.delete(key);
    for (const job of this.jobs.values())
      if (savedKey(job) === key) this.jobs.delete(job.id);
    this.database.settings.set(SAVED_KEY, [...this.saved.values()]);
    this.local.startScan();
    await this.local.waitForScan();

    const remoteSource = this.database.titles
      .get(record.job.titleId)
      ?.sources?.find((source) => source.id === record.job.sourceId);
    if (remoteSource) {
      const episode =
        remoteSource.seasonNumber !== null &&
        remoteSource.episodeNumber !== null
          ? {
              seasonNumber: remoteSource.seasonNumber,
              episodeNumber: remoteSource.episodeNumber,
            }
          : undefined;
      this.preferred.set(
        profileId,
        record.job.titleId,
        remoteSource.id,
        episode,
      );
    }
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

  /** Streams the Webshare file into a new temporary file, with size limits. */
  private async download(
    job: OfflineDownload,
    candidateId: string,
    temporary: string,
    signal: AbortSignal,
  ): Promise<void> {
    const url = validatePlaybackSourceUrl(
      await this.webshare
        .forProfile(job.profileId)
        .createVideoLink(candidateId),
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
  }

  private async directFolder(rootId: string): Promise<string> {
    const root = this.local.getRoot(rootId);
    if (!root || (await realpath(root.path)) !== root.path)
      throw new Error("Destination folder is unavailable.");
    const folder = join(root.path, DIRECT_FOLDER);
    await mkdir(folder, { recursive: true });
    if ((await realpath(folder)) !== folder)
      throw new Error("Destination folder changed while preparing download.");
    return folder;
  }

  private async transferDirect(
    job: OfflineDownload,
    candidateId: string,
    filename: string,
    signal: AbortSignal,
    existing?: SavedDownload,
  ): Promise<void> {
    const folder = await this.directFolder(job.rootId);
    const name = safeName(filename);
    if (!name) throw new Error("Source filename is invalid.");
    let target = existing?.target;
    if (target && dirname(target) !== folder)
      throw new Error("The saved file is no longer in the Fast Search folder.");
    if (!target) {
      // Keep files that are already there: "name (2).mkv", "name (3).mkv", …
      const extension = extname(name);
      const base = name.slice(0, name.length - extension.length);
      for (let copy = 1; ; copy++) {
        const candidate = join(
          folder,
          copy === 1 ? name : `${base} (${copy})${extension}`,
        );
        try {
          await access(candidate);
        } catch {
          target = candidate;
          break;
        }
        if (copy > 99) throw new Error("Too many files with the same name.");
      }
    }
    const temporary = `${target}.part-${job.id}`;
    try {
      await this.download(job, candidateId, temporary, signal);
      await rename(temporary, target!);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    this.local.startScan();
    await this.local.waitForScan();
    const indexed = this.local
      .allFiles()
      .find((file) => file.path === target && file.rootId === job.rootId);
    // Mark complete and saved together so the job never drops out of list().
    job.state = "complete";
    this.saved.set(savedKey(job), {
      job: { ...job },
      target: target!,
      candidateId: indexed?.id ?? "",
    });
    this.database.settings.set(SAVED_KEY, [...this.saved.values()]);
  }

  private async removeDirect(
    key: string,
    record: SavedDownload,
  ): Promise<boolean> {
    const folder = await this.directFolder(record.job.rootId);
    if (dirname(record.target) !== folder)
      throw new Error("The saved file is outside the Fast Search folder.");
    try {
      if ((await realpath(record.target)) !== record.target)
        throw new Error("The saved file has been moved outside its folder.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(record.target, { force: true });
    this.saved.delete(key);
    for (const job of this.jobs.values())
      if (savedKey(job) === key) this.jobs.delete(job.id);
    this.database.settings.set(SAVED_KEY, [...this.saved.values()]);
    this.local.startScan();
    await this.local.waitForScan();
    return true;
  }

  private async transfer(
    job: OfflineDownload,
    candidateId: string,
    filename: string,
    selectedEpisode:
      { seasonNumber: number; episodeNumber: number } | undefined,
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
      await this.download(job, candidateId, temporary, signal);
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
          (source.candidateId === indexed?.id ||
            (indexed?.contentHash !== undefined &&
              this.local.getFile(source.candidateId)?.contentHash ===
                indexed.contentHash)),
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
