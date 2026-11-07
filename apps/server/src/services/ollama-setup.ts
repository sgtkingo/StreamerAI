import { randomUUID } from "node:crypto";
import { existsSync, statfsSync } from "node:fs";
import { totalmem } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const SERVER_OLLAMA_ORIGIN = "http://127.0.0.1:11434";
export const RECOMMENDED_LOCAL_MODEL = "qwen3.5:4b";
const GIB = 1024 ** 3;

export interface LocalModelDownload {
  id: string | null;
  state: "idle" | "downloading" | "ready" | "error";
  error: "DOWNLOAD_FAILED" | "DOWNLOAD_CANCELLED" | null;
}
export interface ServerAiSetupStatus {
  runtime: "ready" | "installed-not-running" | "missing" | "unavailable";
  runtimeVersion: string | null;
  model: { name: typeof RECOMMENDED_LOCAL_MODEL; present: boolean };
  installedModels: string[];
  download: LocalModelDownload;
  resources: {
    memoryBytes: number;
    freeDiskBytes: number | null;
    recommendedMemoryBytes: number;
    estimatedModelBytes: number;
    recommendedFreeDiskBytes: number;
    diskSpaceScope: "model-store" | "unknown";
  };
  installer: {
    configureArgument: "--configure-ai";
    runtimeInstallFromBrowser: false;
  };
}
interface SetupOptions {
  dataDirectory: string;
  /** Only set when the installer has verified Ollama's actual model store. */
  modelDirectory?: string;
  fetch?: typeof fetch;
  installed?: () => boolean;
  resources?: () => Pick<
    ServerAiSetupStatus["resources"],
    "memoryBytes" | "freeDiskBytes"
  >;
}
export class ServerAiSetupError extends Error {
  constructor(
    readonly code:
      | "OLLAMA_RUNTIME_REQUIRED"
      | "OLLAMA_MODEL_DISK_SPACE"
      | "OLLAMA_SETUP_CLOSED",
  ) {
    super(code);
  }
}

/** Read-only host detection. Never runs an executable discovered through PATH. */
export function hasOllamaExecutable(): boolean {
  const executable = process.platform === "win32" ? "ollama.exe" : "ollama";
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA)
      directories.push(join(process.env.LOCALAPPDATA, "Programs", "Ollama"));
    if (process.env.ProgramFiles)
      directories.push(join(process.env.ProgramFiles, "Ollama"));
  } else directories.push("/usr/local/bin", "/usr/bin", "/opt/ollama/bin");
  return directories.some((directory) =>
    existsSync(join(directory, executable)),
  );
}

/** Fixed-loopback setup only: browsers cannot choose commands, runtime URLs or models. */
export class ServerAiSetupService {
  private readonly fetcher: typeof fetch;
  private readonly installed: () => boolean;
  private download: LocalModelDownload = {
    id: null,
    state: "idle",
    error: null,
  };
  private controller: AbortController | null = null;
  private job: Promise<void> | null = null;
  private closed = false;
  constructor(private readonly options: SetupOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.installed = options.installed ?? hasOllamaExecutable;
  }
  private resources(): ServerAiSetupStatus["resources"] {
    let freeDiskBytes: number | null = null;
    if (!this.options.resources && this.options.modelDirectory) {
      try {
        const disk = statfsSync(resolve(this.options.modelDirectory));
        freeDiskBytes = disk.bavail * disk.bsize;
      } catch {
        /* Disk capacity may be unavailable; never infer zero. */
      }
    }
    return {
      ...(this.options.resources?.() ?? {
        memoryBytes: totalmem(),
        freeDiskBytes,
      }),
      recommendedMemoryBytes: 8 * GIB,
      estimatedModelBytes: 3_600_000_000,
      recommendedFreeDiskBytes: 8 * GIB,
      diskSpaceScope:
        this.options.resources || freeDiskBytes !== null
          ? "model-store"
          : "unknown",
    };
  }
  private async json(
    path: "/api/version" | "/api/tags",
    onResponse?: () => void,
  ): Promise<unknown> {
    const response = await this.fetcher(SERVER_OLLAMA_ORIGIN + path, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
      headers: { accept: "application/json" },
    });
    onResponse?.();
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("OLLAMA_UNAVAILABLE");
    }
    return this.readJson(response);
  }
  private async readJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("OLLAMA_EMPTY_RESPONSE");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 256 * 1024) {
        await reader.cancel();
        throw new Error("OLLAMA_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
  async status(): Promise<ServerAiSetupStatus> {
    let runtime: ServerAiSetupStatus["runtime"];
    let runtimeVersion: string | null = null;
    let present = false;
    let installedModels: string[] = [];
    let contacted = false;
    try {
      const version = await this.json("/api/version", () => {
        contacted = true;
      });
      const tags = await this.json("/api/tags");
      if (
        !version ||
        typeof version !== "object" ||
        !("version" in version) ||
        typeof version.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version.version) ||
        !tags ||
        typeof tags !== "object" ||
        !("models" in tags) ||
        !Array.isArray(tags.models)
      )
        throw new Error("OLLAMA_INVALID_RESPONSE");
      runtime = "ready";
      runtimeVersion = version.version;
      installedModels = [
        ...new Set(
          tags.models.flatMap((item: unknown) => {
            if (!item || typeof item !== "object") return [];
            const name =
              "name" in item ? item.name : "model" in item ? item.model : null;
            return typeof name === "string" &&
              /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(name)
              ? [name]
              : [];
          }),
        ),
      ].slice(0, 64);
      present = tags.models.some(
        (item: unknown) =>
          !!item &&
          typeof item === "object" &&
          (("name" in item && item.name === RECOMMENDED_LOCAL_MODEL) ||
            ("model" in item && item.model === RECOMMENDED_LOCAL_MODEL)),
      );
    } catch {
      runtime = contacted
        ? "unavailable"
        : this.installed()
          ? "installed-not-running"
          : "missing";
    }
    return {
      runtime,
      runtimeVersion,
      model: { name: RECOMMENDED_LOCAL_MODEL, present },
      installedModels,
      download: { ...this.download },
      resources: this.resources(),
      installer: {
        configureArgument: "--configure-ai",
        runtimeInstallFromBrowser: false,
      },
    };
  }
  async startModelDownload(): Promise<{
    alreadyPresent: boolean;
    download: LocalModelDownload;
  }> {
    if (this.closed) throw new ServerAiSetupError("OLLAMA_SETUP_CLOSED");
    if (this.job)
      return { alreadyPresent: false, download: { ...this.download } };
    const status = await this.status();
    if (status.model.present)
      return {
        alreadyPresent: true,
        download: { ...this.download, state: "ready" },
      };
    if (status.runtime !== "ready")
      throw new ServerAiSetupError("OLLAMA_RUNTIME_REQUIRED");
    if (
      status.resources.freeDiskBytes !== null &&
      status.resources.freeDiskBytes <
        status.resources.estimatedModelBytes * 1.2
    )
      throw new ServerAiSetupError("OLLAMA_MODEL_DISK_SPACE");
    // Re-check after awaited detection to deduplicate simultaneous callers.
    if (this.job)
      return { alreadyPresent: false, download: { ...this.download } };
    const controller = new AbortController();
    this.controller = controller;
    this.download = { id: randomUUID(), state: "downloading", error: null };
    this.job = this.pull(controller).finally(() => {
      this.job = null;
      this.controller = null;
    });
    return { alreadyPresent: false, download: { ...this.download } };
  }
  private async pull(controller: AbortController): Promise<void> {
    const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
    timeout.unref();
    try {
      const response = await this.fetcher(SERVER_OLLAMA_ORIGIN + "/api/pull", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: RECOMMENDED_LOCAL_MODEL, stream: false }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("OLLAMA_PULL_FAILED");
      }
      const result = (await this.readJson(response)) as { status?: unknown };
      if (result?.status !== "success") throw new Error("OLLAMA_PULL_FAILED");
      this.download = { ...this.download, state: "ready", error: null };
    } catch {
      this.download = {
        ...this.download,
        state: "error",
        error: controller.signal.aborted
          ? "DOWNLOAD_CANCELLED"
          : "DOWNLOAD_FAILED",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.job;
  }
}
