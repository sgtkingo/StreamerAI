import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  verifyRelease,
  type ReleaseArtifact,
  type ReplayState,
} from "../../../scripts/distribution/verify-release.mjs";

/** Public keys pinned at build time from packaging/update-trust.json. */
declare const __STREAMERAI_UPDATE_TRUST__: string;

export const CLIENT_UPDATE_MANIFEST =
  "https://github.com/sgtkingo/StreamerAI/releases/latest/download/stable.json";

export interface ClientUpdate {
  version: string;
  artifact: ReleaseArtifact;
  state: ReplayState;
}

/**
 * Returns the newer signed desktop app release, or null when this app is
 * current, the release has no Windows app or the metadata is not trusted.
 */
export function selectClientUpdate(input: {
  envelope: unknown;
  trust: unknown;
  currentVersion: string;
  state: ReplayState;
  now?: number;
}): ClientUpdate | null {
  try {
    const verified = verifyRelease({
      root: input.trust,
      envelope: input.envelope,
      state: input.state,
      currentVersion: input.currentVersion,
      platform: "win-x64",
      component: "client",
      channel: "stable",
      now: input.now,
    });
    if (verified.metadata.version === input.currentVersion) return null;
    return {
      version: verified.metadata.version,
      artifact: verified.artifact,
      state: verified.state,
    };
  } catch {
    return null;
  }
}

export interface ClientUpdaterOptions {
  currentVersion: string;
  directory: string;
  fetch: typeof fetch;
  /** Asks the person; true installs now, false installs when the app quits. */
  confirm(version: string): Promise<boolean>;
  quit(): void;
  log?(message: string): void;
}

/**
 * Background updates for the Windows desktop app: check the signed release
 * metadata, download and verify the installer, then install it silently on
 * restart (now or when the app next quits).
 */
export class ClientUpdater {
  #pending: string | null = null;
  #timers: NodeJS.Timeout[] = [];
  #checking = false;
  constructor(private readonly options: ClientUpdaterOptions) {}

  start() {
    const check = () => void this.check().catch(() => undefined);
    this.#timers.push(
      setTimeout(check, 30_000),
      setInterval(check, 12 * 60 * 60 * 1000),
    );
    for (const timer of this.#timers) timer.unref?.();
  }

  stop() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
  }

  /** Installs a downloaded update when the app quits (unless already done). */
  installOnQuit() {
    if (!this.#pending) return;
    this.#launch(this.#pending, false);
    this.#pending = null;
  }

  async check(): Promise<string | null> {
    if (this.#checking || this.#pending) return null;
    this.#checking = true;
    try {
      const stateFile = join(this.options.directory, "update-state.json");
      const state = (await readFile(stateFile, "utf8").then(
        JSON.parse,
        () => ({}),
      )) as ReplayState;
      const response = await this.options.fetch(CLIENT_UPDATE_MANIFEST, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      const text = await response.text();
      if (text.length > 512 * 1024) return null;
      const update = selectClientUpdate({
        envelope: JSON.parse(text),
        trust: JSON.parse(__STREAMERAI_UPDATE_TRUST__),
        currentVersion: this.options.currentVersion,
        state,
      });
      if (!update) return null;
      const installer = await this.#download(update.artifact);
      await writeFile(stateFile, JSON.stringify(update.state));
      this.#pending = installer;
      this.options.log?.(
        `StreamerAI app ${update.version} is ready to install.`,
      );
      if (await this.options.confirm(update.version)) {
        this.#launch(installer, true);
        this.#pending = null;
        this.options.quit();
      }
      return update.version;
    } finally {
      this.#checking = false;
    }
  }

  async #download(artifact: ReleaseArtifact) {
    await mkdir(this.options.directory, { recursive: true });
    const target = join(this.options.directory, artifact.filename);
    if (await matches(target, artifact)) return target;
    const partial = `${target}.partial`;
    await rm(partial, { force: true });
    const response = await this.options.fetch(artifact.url, {
      signal: AbortSignal.timeout(60 * 60 * 1000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Update download failed (HTTP ${response.status}).`);
    await pipeline(
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      ),
      createWriteStream(partial, { flags: "wx" }),
    );
    if (!(await matches(partial, artifact))) {
      await rm(partial, { force: true });
      throw new Error("The downloaded app update failed verification.");
    }
    await rename(partial, target);
    return target;
  }

  #launch(installer: string, restart: boolean) {
    // electron-builder NSIS: /S installs silently for this user; --force-run
    // starts the app again afterwards.
    spawn(installer, restart ? ["/S", "--force-run"] : ["/S"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  }
}

async function matches(filename: string, artifact: ReleaseArtifact) {
  try {
    if ((await stat(filename)).size !== artifact.bytes) return false;
    const hash = createHash("sha256");
    hash.update(await readFile(filename));
    return hash.digest("hex") === artifact.sha256;
  } catch {
    return false;
  }
}
