import { createHash, randomUUID } from "node:crypto";
import { mkdir, opendir, realpath, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { StreamerDatabase } from "@streamer-ai/database";
import type { MediaFormat, TitleSource } from "@streamer-ai/contracts";

export const LOCAL_MEDIA_EXTENSIONS = [
  "mkv",
  "avi",
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mpg",
  "mpeg",
  "ts",
  "m2ts",
] as const;
export type LocalMediaExtension = (typeof LOCAL_MEDIA_EXTENSIONS)[number];
export interface LocalRoot {
  id: string;
  path: string;
}
export interface LocalMediaFile {
  id: string;
  rootId: string;
  path: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number;
}
interface LocalSettings {
  roots: LocalRoot[];
  extensions: LocalMediaExtension[];
}
interface ManagedFileLink {
  path: string;
  titleId: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}
export interface LocalScanStatus {
  state: "idle" | "scanning" | "complete" | "failed";
  fileCount: number;
  error: string | null;
  completedAt: string | null;
}

const CONFIG_KEY = "local-files.config";
const INDEX_KEY = "local-files.index";
const MANAGED_LINKS_KEY = "local-files.managed-links";
const MAX_FILES = 50_000;
const digest = (value: string, length = 32) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);
const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const inside = (root: string, candidate: string) => {
  const part = relative(root, candidate);
  return (
    part === "" ||
    (part !== ".." && !part.startsWith(".." + sep) && !part.includes(":"))
  );
};
const fileId = (path: string) => digest(path.toLowerCase());
const sourceId = (titleId: string, candidateId: string) =>
  digest(`${titleId}\u0000local-files\u0000${candidateId}`);
const displayName = (name: string) =>
  name
    .replace(/\.[^.]+$/, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const episode = (name: string) => {
  const match =
    /(?:^|[\s._-])S(\d{1,2})E(\d{1,3})(?:[\s._-]|$)/i.exec(name) ??
    /(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?:[\s._-]|$)/i.exec(name);
  if (!match) return null;
  return {
    season: Number(match[1]),
    number: Number(match[2]),
    title: name
      .slice(0, match.index)
      .replace(/[._]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  };
};

export class LocalMediaLibrary {
  private readonly hasSavedConfig: boolean;
  private settings: LocalSettings;
  private files = new Map<string, LocalMediaFile>();
  private managedLinks = new Map<string, ManagedFileLink>();
  private scanController: AbortController | null = null;
  private scanJob: Promise<void> | null = null;
  private status: LocalScanStatus;

  constructor(
    private readonly database: StreamerDatabase,
    private readonly now = () => new Date(),
  ) {
    const saved = database.settings.get<LocalSettings>(CONFIG_KEY);
    this.hasSavedConfig = saved !== null;
    this.settings = {
      roots: Array.isArray(saved?.roots) ? saved.roots : [],
      extensions: Array.isArray(saved?.extensions)
        ? saved.extensions.filter((value): value is LocalMediaExtension =>
            LOCAL_MEDIA_EXTENSIONS.includes(value),
          )
        : [...LOCAL_MEDIA_EXTENSIONS],
    };
    const indexed = database.settings.get<LocalMediaFile[]>(INDEX_KEY);
    for (const item of Array.isArray(indexed) ? indexed : []) {
      if (typeof item.id === "string" && typeof item.path === "string")
        this.files.set(item.id, item);
    }
    const links = database.settings.get<ManagedFileLink[]>(MANAGED_LINKS_KEY);
    for (const link of Array.isArray(links) ? links : []) {
      if (typeof link.path === "string" && typeof link.titleId === "string")
        this.managedLinks.set(link.path, link);
    }
    this.status = {
      state: "idle",
      fileCount: this.files.size,
      error: null,
      completedAt: null,
    };
  }

  getConfig() {
    return {
      roots: [...this.settings.roots],
      extensions: [...this.settings.extensions],
      scan: { ...this.status },
    };
  }

  getFile(id: string): LocalMediaFile | null {
    return this.files.get(id) ?? null;
  }
  allFiles(): LocalMediaFile[] {
    return [...this.files.values()];
  }
  getRoot(id: string): LocalRoot | null {
    return this.settings.roots.find((root) => root.id === id) ?? null;
  }

  /** Preserve the exact catalog identity of a managed download across scans. */
  async linkManagedFile(
    path: string,
    titleId: string,
    episodeSelection?: { seasonNumber: number; episodeNumber: number },
  ): Promise<void> {
    const canonical = await realpath(path);
    const title = this.database.titles.get(titleId);
    if (
      canonical !== path ||
      !this.settings.roots.some((root) => inside(root.path, canonical)) ||
      !title ||
      (title.kind === "series" && !episodeSelection) ||
      (title.kind === "movie" && episodeSelection) ||
      !(await stat(canonical)).isFile()
    )
      throw new Error("The saved file cannot be linked to this title.");
    this.managedLinks.set(path, {
      path,
      titleId,
      seasonNumber: episodeSelection?.seasonNumber ?? null,
      episodeNumber: episodeSelection?.episodeNumber ?? null,
    });
    this.saveManagedLinks();
  }

  unlinkManagedFile(path: string): void {
    if (!this.managedLinks.delete(path)) return;
    this.saveManagedLinks();
  }

  private saveManagedLinks(): void {
    this.database.settings.set(MANAGED_LINKS_KEY, [
      ...this.managedLinks.values(),
    ]);
  }

  /** Only first-run installations receive the managed local library root. */
  async ensureDefaultRoot(path: string): Promise<void> {
    if (this.hasSavedConfig || this.settings.roots.length > 0) return;
    await mkdir(path, { recursive: true });
    await this.addRoot(path);
  }

  async addRoot(input: string): Promise<LocalRoot> {
    const canonical = await realpath(input.trim());
    if (!(await stat(canonical)).isDirectory())
      throw new Error("Choose a folder or mounted drive.");
    if (
      this.settings.roots.some(
        (root) => root.path.toLowerCase() === canonical.toLowerCase(),
      )
    )
      throw new Error("This folder is already connected.");
    const root = { id: randomUUID(), path: canonical };
    this.settings.roots.push(root);
    this.saveConfig();
    this.startScan();
    return root;
  }

  removeRoot(id: string): boolean {
    const root = this.getRoot(id);
    const count = this.settings.roots.length;
    this.settings.roots = this.settings.roots.filter((root) => root.id !== id);
    if (this.settings.roots.length === count) return false;
    if (root) {
      for (const path of this.managedLinks.keys())
        if (inside(root.path, path)) this.managedLinks.delete(path);
      this.saveManagedLinks();
    }
    this.saveConfig();
    this.startScan();
    return true;
  }

  disconnect(): void {
    this.settings.roots = [];
    this.managedLinks.clear();
    this.saveManagedLinks();
    this.saveConfig();
    this.startScan();
  }

  setExtensions(extensions: string[]): void {
    if (
      !Array.isArray(extensions) ||
      extensions.some(
        (value) =>
          !LOCAL_MEDIA_EXTENSIONS.includes(value as LocalMediaExtension),
      )
    )
      throw new Error("Choose supported video formats.");
    this.settings.extensions = [
      ...new Set(extensions),
    ] as LocalMediaExtension[];
    this.saveConfig();
    this.startScan();
  }

  startScan(): void {
    this.scanController?.abort();
    const controller = new AbortController();
    this.scanController = controller;
    this.status = { ...this.status, state: "scanning", error: null };
    const job = this.scan(controller.signal)
      .then(() => {
        if (!controller.signal.aborted)
          this.status = {
            state: "complete",
            fileCount: this.files.size,
            error: null,
            completedAt: this.now().toISOString(),
          };
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          this.status = {
            ...this.status,
            state: "failed",
            error: error instanceof Error ? error.message : "Scan failed.",
          };
      })
      .finally(() => {
        if (this.scanController === controller) {
          this.scanController = null;
          this.scanJob = null;
        }
      });
    this.scanJob = job;
  }

  async waitForScan(): Promise<void> {
    await this.scanJob;
  }
  async close(): Promise<void> {
    this.scanController?.abort();
    await this.scanJob;
  }

  async resolveFile(id: string): Promise<LocalMediaFile> {
    const file = this.files.get(id);
    const root = file && this.getRoot(file.rootId);
    if (!file || !root) throw new Error("Local file is no longer indexed.");
    const canonical = await realpath(file.path);
    if (!inside(root.path, canonical) || canonical !== file.path)
      throw new Error("Local file moved outside its connected folder.");
    if (!(await stat(canonical)).isFile())
      throw new Error("Local file is unavailable.");
    return file;
  }

  private saveConfig(): void {
    this.database.settings.set(CONFIG_KEY, this.settings);
  }

  private async scan(signal: AbortSignal): Promise<void> {
    const next = new Map<string, LocalMediaFile>();
    const extensions = new Set(this.settings.extensions);
    for (const root of this.settings.roots) {
      const dirs = [root.path];
      while (dirs.length > 0) {
        signal.throwIfAborted();
        const dir = dirs.pop()!;
        let handle;
        try {
          handle = await opendir(dir);
        } catch {
          continue;
        }
        for await (const entry of handle) {
          signal.throwIfAborted();
          if (entry.isSymbolicLink()) continue;
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            dirs.push(path);
            continue;
          }
          if (
            !entry.isFile() ||
            !extensions.has(
              extname(entry.name).slice(1).toLowerCase() as LocalMediaExtension,
            )
          )
            continue;
          try {
            const info = await stat(path);
            const id = fileId(path);
            next.set(id, {
              id,
              rootId: root.id,
              path,
              name: entry.name,
              sizeBytes: info.size,
              modifiedMs: info.mtimeMs,
            });
          } catch {
            continue;
          }
          if (next.size > MAX_FILES)
            throw new Error("Local library limit of 50,000 files reached.");
        }
      }
    }
    signal.throwIfAborted();
    this.files = next;
    this.database.settings.set(INDEX_KEY, [...next.values()]);
    this.enrichLibrary();
  }

  enrichLibrary(profileId?: string): void {
    const profiles = profileId
      ? [this.database.profiles.get(profileId)].filter(
          (value) => value !== null,
        )
      : this.database.profiles.list();
    const existing = this.database.titles.list();
    const matchedByKey = new Map<string, (typeof existing)[number]>();
    for (const item of existing)
      for (const label of [item.title, item.originalTitle]) {
        if (!label) continue;
        const key = `${item.kind}:${normalize(label)}`;
        if (!matchedByKey.has(key)) matchedByKey.set(key, item);
      }
    const groups = new Map<
      string,
      {
        titleId: string;
        title: string;
        kind: "movie" | "series";
        files: LocalMediaFile[];
      }
    >();
    for (const file of this.files.values()) {
      const link = this.managedLinks.get(file.path);
      const linkedTitle = link && this.database.titles.get(link.titleId);
      const parsed = episode(file.name);
      const kind = linkedTitle?.kind ?? (parsed ? "series" : "movie");
      const rawTitle =
        linkedTitle?.title ||
        parsed?.title ||
        displayName(file.name)
          .replace(/\b(?:19|20)\d{2}\b.*$/, "")
          .trim();
      const key = normalize(rawTitle);
      if (!key) continue;
      const matched = linkedTitle ?? matchedByKey.get(`${kind}:${key}`);
      const titleId = matched?.id ?? `local-${digest(kind + ":" + key, 24)}`;
      const group = groups.get(titleId) ?? {
        titleId,
        title: matched?.title ?? rawTitle,
        kind,
        files: [],
      };
      group.files.push(file);
      groups.set(titleId, group);
    }
    const now = this.now().toISOString();
    const touched = new Set(
      existing
        .filter((item) =>
          item.sources?.some((source) => source.providerId === "local-files"),
        )
        .map((item) => item.id),
    );
    for (const group of groups.values()) {
      const previous = this.database.titles.get(group.titleId);
      if (!previous)
        this.database.titles.upsert({
          id: group.titleId,
          kind: group.kind,
          title: group.title,
          originalTitle: null,
          year: null,
          synopsis: "Local media file",
          posterUrl: null,
          backdropUrl: null,
          accentColor: "#55565b",
          genres: [],
          ratings: [],
          availability: "unknown",
          availabilityProvider: null,
          availabilityCheckedAt: null,
          formats: [],
          sources: [],
          seriesCoverage: null,
          metadataProvider: "local-files",
          metadataValidatedAt: now,
        });
      touched.add(group.titleId);
    }
    for (const titleId of touched) {
      const title = this.database.titles.get(titleId)!;
      const group = groups.get(titleId);
      const localSources: TitleSource[] = (group?.files ?? [])
        .slice(0, 1_000)
        .flatMap((file) => {
          const link = this.managedLinks.get(file.path);
          const parsed =
            link?.titleId === titleId
              ? link.seasonNumber === null || link.episodeNumber === null
                ? null
                : { season: link.seasonNumber, number: link.episodeNumber }
              : episode(file.name);
          if (title.kind === "series" && !parsed) return [];
          const format: MediaFormat = {
            label: extname(file.name).slice(1).toUpperCase(),
            container: extname(file.name).slice(1).toLowerCase(),
            resolution: null,
            videoCodec: null,
            audioLanguages: [],
            subtitleLanguages: [],
          };
          return [
            {
              id: sourceId(titleId, file.id),
              providerId: "local-files",
              candidateId: file.id,
              releaseName: file.name,
              sizeBytes: file.sizeBytes,
              format,
              seasonNumber: parsed?.season ?? null,
              episodeNumber: parsed?.number ?? null,
              checkedAt: now,
            },
          ];
        });
      this.database.titles.replaceProviderSources(
        titleId,
        "local-files",
        localSources,
      );
      if (localSources.length > 0)
        for (const profile of profiles) {
          if (!this.database.library.get(profile.id, titleId))
            this.database.library.upsert({
              profileId: profile.id,
              titleId,
              membershipReason: "explicit",
              state: "saved",
            });
        }
      if (localSources.length === 0 && title.metadataProvider === "local-files")
        for (const profile of profiles)
          this.database.library.remove(profile.id, titleId);
    }
  }

  ensureProfileLibrary(profileId: string): void {
    if (!this.database.profiles.get(profileId)) return;
    for (const title of this.database.titles.list()) {
      if (!title.sources?.some((source) => source.providerId === "local-files"))
        continue;
      if (!this.database.library.get(profileId, title.id))
        this.database.library.upsert({
          profileId,
          titleId: title.id,
          membershipReason: "explicit",
          state: "saved",
        });
    }
  }
}
