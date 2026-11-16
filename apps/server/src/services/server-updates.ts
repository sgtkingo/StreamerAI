import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
} from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const UPDATE_MANIFEST_URL =
  "https://github.com/sgtkingo/StreamerAI/releases/latest/download/stable.json";
const RELEASE_PAGE = "https://github.com/sgtkingo/StreamerAI/releases/tag/v";
const REQUEST_FORMAT = "streamerai-update-request/v1";
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
/** Local hours [start, end) in which an enabled nightly install may run. */
export const NIGHTLY_WINDOW = { startHour: 2, endHour: 5 } as const;

export type UpdateState =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface ServerUpdateSettings {
  autoDownload: boolean;
  nightlyInstall: boolean;
}

export interface ServerUpdateResult {
  result: "installed" | "current" | "rolled-back" | "failed";
  version: string | null;
  from: string | null;
  message?: string;
  at: string;
}

export interface ServerUpdateStatus {
  supported: boolean;
  unsupportedReason?: "development" | "platform";
  currentVersion: string;
  state: UpdateState;
  latestVersion: string | null;
  releaseNotesUrl: string | null;
  downloadBytes: number | null;
  downloadedBytes: number | null;
  checkedAt: string | null;
  error: string | null;
  settings: ServerUpdateSettings;
  /** The owner asked to be reminded later; the offer is hidden until then. */
  remindAfter: string | null;
  /** True while the household is watching; nightly installs wait. */
  playbackActive: boolean;
  nightlyWindow: { startHour: number; endHour: number };
  lastResult: ServerUpdateResult | null;
}

interface ReleaseArtifact {
  platform: string;
  filename: string;
  bytes: number;
  sha256: string;
  url: string;
}

export interface VerifiedRelease {
  metadata: { version: string };
  artifact: ReleaseArtifact;
}

export type ReleaseVerifier = (input: {
  root: unknown;
  envelope: unknown;
  state: Record<string, unknown>;
  currentVersion: string;
  platform: string;
  component: string;
  channel: string;
}) => VerifiedRelease;

export class ServerUpdateError extends Error {
  constructor(
    readonly code:
      | "UPDATES_UNSUPPORTED"
      | "UPDATE_NOT_AVAILABLE"
      | "UPDATE_NOT_DOWNLOADED"
      | "UPDATE_VERSION_CHANGED"
      | "UPDATE_BUSY"
      | "PLAYBACK_ACTIVE",
    message: string,
  ) {
    super(message);
  }
}

export interface ServerUpdateOptions {
  currentVersion: string;
  /** STREAMERAI_STATE_ROOT of an installed release; absent in development. */
  stateRoot?: string;
  /** STREAMERAI_RELEASE_ROOT of an installed release; absent in development. */
  releaseRoot?: string;
  platform?: NodeJS.Platform;
  manifestUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  isPlaybackActive?: () => boolean;
  /** Defaults to the release's own service/verify-release.mjs. */
  verifier?: ReleaseVerifier;
  /** Defaults to the release's own service/update-trust.json. */
  trust?: unknown;
  checkIntervalMs?: number;
  nightlyTickMs?: number;
  log?: (message: string) => void;
}

function compareVersions(left: string, right: string) {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  if (!a || !b) return 0;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  return a[4] < b[4] ? -1 : 1;
}

const DEFAULT_SETTINGS: ServerUpdateSettings = {
  autoDownload: true,
  nightlyInstall: false,
};

/**
 * Offers signed server updates to the household owner.
 *
 * The server (LocalService) never replaces its own files: it checks the
 * signed release metadata, downloads and verifies the archive into
 * STATE/updates/download and, once the owner approves or the nightly window
 * allows, writes STATE/updates/request.json. The StreamerAIUpdater service
 * re-verifies the release with administrator-owned trust and activates it,
 * rolling back when the new version does not become ready.
 */
export class ServerUpdateService {
  readonly #options: Required<
    Pick<
      ServerUpdateOptions,
      "currentVersion" | "platform" | "manifestUrl" | "fetch" | "now"
    >
  > &
    ServerUpdateOptions;
  #state: UpdateState;
  #latest: VerifiedRelease | null = null;
  #envelopeText: string | null = null;
  #checkedAt: string | null = null;
  #error: string | null = null;
  #downloaded = 0;
  #settings: ServerUpdateSettings = { ...DEFAULT_SETTINGS };
  #remindAfter: string | null = null;
  #loaded: Promise<void> | null = null;
  #operation: Promise<unknown> | null = null;
  #timers: NodeJS.Timeout[] = [];
  #verifier: Promise<ReleaseVerifier> | null = null;

  constructor(options: ServerUpdateOptions) {
    this.#options = {
      platform: process.platform,
      manifestUrl: UPDATE_MANIFEST_URL,
      fetch,
      now: () => new Date(),
      ...options,
    };
    this.#state = this.supported ? "idle" : "unsupported";
  }

  get supported() {
    return (
      !!this.#options.stateRoot &&
      !!this.#options.releaseRoot &&
      this.#options.platform === "win32"
    );
  }

  get #updates() {
    return join(this.#options.stateRoot!, "updates");
  }
  get #download() {
    return join(this.#updates, "download");
  }

  /** Starts the periodic check and the nightly install window. */
  start() {
    if (!this.supported || this.#timers.length) return;
    const check = () =>
      void this.check().catch((error: unknown) =>
        this.#options.log?.(
          `Server update check failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    this.#timers.push(
      setTimeout(check, 60_000),
      setInterval(check, this.#options.checkIntervalMs ?? 6 * 60 * 60 * 1000),
      setInterval(
        () => void this.nightlyTick().catch(() => undefined),
        this.#options.nightlyTickMs ?? 10 * 60 * 1000,
      ),
    );
    for (const timer of this.#timers) timer.unref?.();
  }

  close() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
  }

  async status(): Promise<ServerUpdateStatus> {
    await this.#load();
    const lastResult = await this.#lastResult();
    const state = (await this.#updaterInstalling())
      ? "installing"
      : this.#state;
    const latest = this.#latest?.metadata.version ?? null;
    return {
      supported: this.supported,
      ...(this.supported
        ? {}
        : {
            unsupportedReason:
              this.#options.stateRoot && this.#options.releaseRoot
                ? ("platform" as const)
                : ("development" as const),
          }),
      currentVersion: this.#options.currentVersion,
      state,
      latestVersion: latest,
      releaseNotesUrl: latest ? `${RELEASE_PAGE}${latest}` : null,
      downloadBytes: this.#latest?.artifact.bytes ?? null,
      downloadedBytes:
        state === "downloading" || state === "ready" ? this.#downloaded : null,
      checkedAt: this.#checkedAt,
      error: this.#error,
      settings: { ...this.#settings },
      remindAfter: this.#remindAfter,
      playbackActive: this.#options.isPlaybackActive?.() ?? false,
      nightlyWindow: { ...NIGHTLY_WINDOW },
      lastResult,
    };
  }

  /** Fetches and verifies the signed release metadata. */
  async check(): Promise<ServerUpdateStatus> {
    this.#requireSupported();
    await this.#load();
    if (this.#operation) {
      await this.#operation.catch(() => undefined);
      return this.status();
    }
    const previous = this.#state;
    this.#state = "checking";
    const operation = (async () => {
      try {
        const response = await this.#options.fetch(this.#options.manifestUrl, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok)
          throw new Error(
            `The release information is unavailable (HTTP ${response.status}).`,
          );
        const text = await response.text();
        if (text.length > MAX_METADATA_BYTES)
          throw new Error("The release information is too large.");
        const verified = await this.#verify(JSON.parse(text));
        this.#checkedAt = this.#options.now().toISOString();
        this.#error = null;
        if (
          compareVersions(
            verified.metadata.version,
            this.#options.currentVersion,
          ) <= 0
        ) {
          this.#latest = null;
          this.#envelopeText = null;
          this.#state = "idle";
          return;
        }
        const changed =
          this.#latest?.metadata.version !== verified.metadata.version ||
          this.#latest?.artifact.sha256 !== verified.artifact.sha256;
        this.#latest = verified;
        this.#envelopeText = text;
        if (changed) this.#downloaded = 0;
        this.#state =
          !changed && previous === "ready"
            ? "ready"
            : (await this.#hasVerifiedDownload())
              ? "ready"
              : "available";
      } catch (error) {
        this.#checkedAt = this.#options.now().toISOString();
        this.#error =
          error instanceof Error
            ? error.message
            : "The update check did not finish.";
        this.#state = this.#latest
          ? previous === "ready"
            ? "ready"
            : "available"
          : "error";
      }
    })();
    this.#operation = operation;
    try {
      await operation;
    } finally {
      this.#operation = null;
    }
    if (
      (this.#state as UpdateState) === "available" &&
      this.#settings.autoDownload
    )
      void this.#startDownload();
    return this.status();
  }

  /** Downloads and verifies the archive of the offered release. */
  async download(): Promise<ServerUpdateStatus> {
    this.#requireSupported();
    await this.#load();
    if (this.#operation) await this.#operation.catch(() => undefined);
    if (this.#state === "ready") return this.status();
    if (!this.#latest || !this.#envelopeText)
      throw new ServerUpdateError(
        "UPDATE_NOT_AVAILABLE",
        "No newer StreamerAI release is available.",
      );
    await this.#startDownload();
    return this.status();
  }

  /** Starts (or joins) the download synchronously so callers cannot race it. */
  #startDownload(): Promise<unknown> {
    if (this.#operation) return this.#operation.catch(() => undefined);
    if (!this.#latest || !this.#envelopeText) return Promise.resolve();
    const release = this.#latest;
    const envelopeText = this.#envelopeText;
    this.#state = "downloading";
    this.#downloaded = 0;
    const operation = (async () => {
      try {
        await this.#prepareDirectory(this.#download);
        const artifact = release.artifact;
        if (artifact.bytes > MAX_ARTIFACT_BYTES)
          throw new Error("The update is larger than expected.");
        const target = join(this.#download, artifact.filename);
        const partial = `${target}.partial`;
        await rm(partial, { force: true });
        const response = await this.#options.fetch(artifact.url, {
          signal: AbortSignal.timeout(60 * 60 * 1000),
        });
        if (!response.ok || !response.body)
          throw new Error(
            `The update download failed (HTTP ${response.status}).`,
          );
        const hash = createHash("sha256");
        let received = 0;
        const counted = Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        ).on("data", (chunk: Buffer) => {
          received += chunk.length;
          this.#downloaded = received;
          if (received > artifact.bytes)
            counted.destroy(new Error("The update download is too large."));
          hash.update(chunk);
        });
        await pipeline(counted, createWriteStream(partial, { flags: "wx" }));
        if (
          received !== artifact.bytes ||
          hash.digest("hex") !== artifact.sha256
        )
          throw new Error(
            "The downloaded update failed verification and was discarded.",
          );
        await rename(partial, target);
        await writeFile(join(this.#download, "stable.json"), envelopeText);
        this.#state = "ready";
        this.#error = null;
      } catch (error) {
        this.#error =
          error instanceof Error ? error.message : "The download failed.";
        this.#state = "available";
        await rm(join(this.#download, `${release.artifact.filename}.partial`), {
          force: true,
        }).catch(() => undefined);
      }
    })();
    this.#operation = operation.finally(() => {
      this.#operation = null;
    });
    return this.#operation;
  }

  /**
   * Hands the verified download to the updater service. The server is
   * stopped by the updater shortly after this returns.
   */
  async install(
    version: string,
    options: { allowDuringPlayback?: boolean } = {},
  ): Promise<ServerUpdateStatus> {
    this.#requireSupported();
    await this.#load();
    if (await this.#updaterInstalling())
      throw new ServerUpdateError(
        "UPDATE_BUSY",
        "An update is already being installed.",
      );
    if (!this.#latest || this.#latest.metadata.version !== version)
      throw new ServerUpdateError(
        "UPDATE_VERSION_CHANGED",
        "The offered update changed. Check for updates again.",
      );
    if (this.#state !== "ready" || !(await this.#hasVerifiedDownload()))
      throw new ServerUpdateError(
        "UPDATE_NOT_DOWNLOADED",
        "Download the update before installing it.",
      );
    if (!options.allowDuringPlayback && this.#options.isPlaybackActive?.())
      throw new ServerUpdateError(
        "PLAYBACK_ACTIVE",
        "Someone is watching right now. Install anyway or try again later.",
      );
    await rm(join(this.#updates, "status.json"), { force: true });
    const temporary = join(this.#updates, `request.${process.pid}.tmp`);
    await writeFile(
      temporary,
      JSON.stringify({
        format: REQUEST_FORMAT,
        version,
        channel: "stable",
        metadata: "stable.json",
        artifact: this.#latest.artifact.filename,
        requestedAt: this.#options.now().toISOString(),
      }),
      { flag: "w" },
    );
    await rename(temporary, join(this.#updates, "request.json"));
    this.#state = "installing";
    this.#options.log?.(
      `Server update ${version} approved; the updater service will restart StreamerAI.`,
    );
    return this.status();
  }

  async updateSettings(
    changes: Partial<ServerUpdateSettings>,
  ): Promise<ServerUpdateStatus> {
    this.#requireSupported();
    await this.#load();
    this.#settings = {
      autoDownload: changes.autoDownload ?? this.#settings.autoDownload,
      nightlyInstall: changes.nightlyInstall ?? this.#settings.nightlyInstall,
    };
    await this.#save();
    if (
      this.#state === "available" &&
      (this.#settings.autoDownload || this.#settings.nightlyInstall)
    )
      void this.#startDownload();
    return this.status();
  }

  /** Hides the offer until `hours` from now; it reappears afterwards. */
  async remindLater(hours = 24): Promise<ServerUpdateStatus> {
    this.#requireSupported();
    await this.#load();
    this.#remindAfter = new Date(
      this.#options.now().getTime() + hours * 60 * 60 * 1000,
    ).toISOString();
    await this.#save();
    return this.status();
  }

  /** Installs a downloaded update inside the nightly window when nobody watches. */
  async nightlyTick(): Promise<boolean> {
    if (!this.supported) return false;
    await this.#load();
    if (!this.#settings.nightlyInstall || !this.#latest) return false;
    const hour = this.#options.now().getHours();
    if (hour < NIGHTLY_WINDOW.startHour || hour >= NIGHTLY_WINDOW.endHour)
      return false;
    if (this.#options.isPlaybackActive?.()) return false;
    if (this.#operation) await this.#operation.catch(() => undefined);
    if (this.#state === "available") await this.download();
    if (this.#state !== "ready") return false;
    await this.install(this.#latest.metadata.version);
    return true;
  }

  #requireSupported() {
    if (!this.supported)
      throw new ServerUpdateError(
        "UPDATES_UNSUPPORTED",
        "Automatic updates are available for installed Windows servers. Update this server manually.",
      );
  }

  async #verify(envelope: unknown) {
    const verifier = await (this.#verifier ??= this.#options.verifier
      ? Promise.resolve(this.#options.verifier)
      : import(
          pathToFileURL(
            join(this.#options.releaseRoot!, "service", "verify-release.mjs"),
          ).href
        ).then(
          (module: { verifyRelease: ReleaseVerifier }) => module.verifyRelease,
        ));
    const root =
      this.#options.trust ??
      JSON.parse(
        await readFile(
          join(this.#options.releaseRoot!, "service", "update-trust.json"),
          "utf8",
        ),
      );
    try {
      return verifier({
        root,
        envelope,
        state: {},
        currentVersion: this.#options.currentVersion,
        platform: "win-x64",
        component: "server",
        channel: "stable",
      });
    } catch (error) {
      // A signed but older release is not an error for the household.
      if (error instanceof Error && /downgrade/i.test(error.message))
        return {
          metadata: { version: this.#options.currentVersion },
          artifact: {} as ReleaseArtifact,
        };
      throw new Error(
        `The release information could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #hasVerifiedDownload() {
    const artifact = this.#latest?.artifact;
    if (!artifact) return false;
    const target = join(this.#download, artifact.filename);
    try {
      if ((await stat(target)).size !== artifact.bytes) return false;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(target))
        hash.update(chunk as Buffer);
      if (hash.digest("hex") !== artifact.sha256) return false;
      this.#downloaded = artifact.bytes;
      if (
        !existsSync(join(this.#download, "stable.json")) &&
        this.#envelopeText
      )
        await writeFile(
          join(this.#download, "stable.json"),
          this.#envelopeText,
        );
      return true;
    } catch {
      return false;
    }
  }

  async #prepareDirectory(directory: string) {
    await mkdir(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink())
      throw new Error("The update directory is not a plain folder.");
  }

  async #load() {
    if (!this.supported) return;
    this.#loaded ??= (async () => {
      try {
        const saved = JSON.parse(
          await readFile(join(this.#updates, "settings.json"), "utf8"),
        ) as Partial<ServerUpdateSettings & { remindAfter: string | null }>;
        this.#settings = {
          autoDownload:
            typeof saved.autoDownload === "boolean"
              ? saved.autoDownload
              : DEFAULT_SETTINGS.autoDownload,
          nightlyInstall:
            typeof saved.nightlyInstall === "boolean"
              ? saved.nightlyInstall
              : DEFAULT_SETTINGS.nightlyInstall,
        };
        this.#remindAfter =
          typeof saved.remindAfter === "string" &&
          Number.isFinite(Date.parse(saved.remindAfter))
            ? saved.remindAfter
            : null;
      } catch {
        /* defaults */
      }
    })();
    await this.#loaded;
  }

  async #save() {
    await this.#prepareDirectory(this.#updates);
    const target = join(this.#updates, "settings.json");
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ ...this.#settings, remindAfter: this.#remindAfter }),
    );
    await rename(temporary, target);
  }

  async #updaterStatus() {
    if (!this.supported) return null;
    try {
      return JSON.parse(
        await readFile(join(this.#updates, "status.json"), "utf8"),
      ) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async #updaterInstalling() {
    if (!this.supported) return false;
    return (
      existsSync(join(this.#updates, "request.json")) ||
      (await this.#updaterStatus())?.state === "installing"
    );
  }

  async #lastResult(): Promise<ServerUpdateResult | null> {
    const status = await this.#updaterStatus();
    if (
      !status ||
      status.state !== "idle" ||
      !["installed", "current", "rolled-back", "failed"].includes(
        String(status.result),
      )
    )
      return null;
    return {
      result: status.result as ServerUpdateResult["result"],
      version: typeof status.version === "string" ? status.version : null,
      from: typeof status.from === "string" ? status.from : null,
      ...(typeof status.message === "string"
        ? { message: status.message.slice(0, 500) }
        : {}),
      at: typeof status.at === "string" ? status.at : "",
    };
  }
}
