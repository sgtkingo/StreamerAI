import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  fallbackCatalog,
  modelOption,
  recommendedModel,
  REASONING_EFFORTS,
  type AgentModelCatalog,
  type ReasoningEffort,
} from "./agent-model-catalog.js";

export type LocalAgentName = "codex" | "claude";
export type LocalAgentEvent =
  | { type: "delta"; text: string }
  | { type: "completed"; text: string; sessionId: string }
  | { type: "failed"; message: string };

export interface AgentSession {
  readonly id: string;
  sendMessage(
    message: string,
    schema: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { model?: string; reasoningEffort?: ReasoningEffort },
  ): Promise<string>;
  streamEvents(): AsyncIterable<LocalAgentEvent>;
  cancel(): Promise<void>;
  closeSession(): Promise<void>;
}

export interface LocalAgentProvider {
  readonly name: LocalAgentName;
  status(): Promise<{ available: boolean; code: string; message: string }>;
  startSession(sessionId?: string): Promise<AgentSession>;
  close(): Promise<void>;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "XDG_CONFIG_HOME",
  ];
  return Object.fromEntries(
    names
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

function commandFor(name: LocalAgentName): string {
  return name === "codex"
    ? process.env.STREAMERAI_CODEX_COMMAND || "codex"
    : process.env.STREAMERAI_CLAUDE_COMMAND || "claude";
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

function runStatus(
  name: LocalAgentName,
): Promise<{ available: boolean; code: string; message: string }> {
  return new Promise((resolve) => {
    const args = name === "codex" ? ["login", "status"] : ["auth", "status"];
    let settled = false;
    const child = spawn(commandFor(name), args, {
      shell: false,
      windowsHide: true,
      env: childEnvironment(),
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      finish("CHECK_TIMEOUT");
    }, 5_000);
    const finish = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        available: code === "READY",
        code,
        message:
          code === "READY"
            ? `${name} is installed and signed in.`
            : code === "NOT_INSTALLED"
              ? `${name} executable was not found.`
              : `${name} is not signed in or could not be checked.`,
      });
    };
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ENOENT" ? "NOT_INSTALLED" : "CHECK_FAILED"),
    );
    child.once("exit", (code) =>
      finish(code === 0 ? "READY" : "NOT_AUTHENTICATED"),
    );
  });
}

class EventQueue implements AsyncIterable<LocalAgentEvent> {
  private items: LocalAgentEvent[] = [];
  private waiter: ((value: IteratorResult<LocalAgentEvent>) => void) | null =
    null;
  private ended = false;
  push(value: LocalAgentEvent): void {
    if (this.ended) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value, done: false });
    } else {
      this.items.push(value);
      if (this.items.length > 256) this.items.shift();
    }
  }
  end(): void {
    this.ended = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = null;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<LocalAgentEvent> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<LocalAgentEvent>>(
        (resolve) => {
          this.waiter = resolve;
        },
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

type RpcMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: unknown;
};

class CodexSession implements AgentSession {
  readonly events = new EventQueue();
  id: string;
  private turnId: string | null = null;
  private running = false;
  constructor(
    private readonly host: CodexHost,
    id: string,
  ) {
    this.id = id;
  }
  streamEvents(): AsyncIterable<LocalAgentEvent> {
    return this.events;
  }
  async sendMessage(
    message: string,
    schema: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { model?: string; reasoningEffort?: ReasoningEffort },
  ): Promise<string> {
    if (this.running)
      throw new Error("A Codex turn is already running in this session.");
    this.running = true;
    let text = "";
    const onAbort = () => {
      void this.cancel();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          void this.cancel();
          reject(new Error("Codex turn timed out."));
        }, 120_000);
        const stop = this.host.listen((event) => {
          if (event.method === "host/exited") {
            stop();
            clearTimeout(timer);
            reject(new Error("Codex app-server exited."));
            return;
          }
          if (event.method === "item/agentMessage/delta") {
            const params = event.params as {
              threadId?: string;
              delta?: string;
            };
            if (
              params?.threadId === this.id &&
              typeof params.delta === "string"
            ) {
              text += params.delta;
              this.events.push({ type: "delta", text: params.delta });
            }
          }
          if (event.method === "turn/completed") {
            const params = event.params as {
              threadId?: string;
              turn?: { status?: string };
            };
            if (params?.threadId !== this.id) return;
            stop();
            clearTimeout(timer);
            if (params.turn?.status === "completed") {
              this.events.push({ type: "completed", text, sessionId: this.id });
              resolve(text);
            } else {
              this.events.push({
                type: "failed",
                message: `Codex turn ${params.turn?.status ?? "failed"}.`,
              });
              reject(new Error("Codex turn did not complete."));
            }
          }
        });
        void this.host
          .request("turn/start", {
            threadId: this.id,
            input: [{ type: "text", text: message }],
            cwd: this.host.cwd,
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: {
                type: "restricted",
                includePlatformDefaults: true,
                readableRoots: [this.host.cwd],
              },
            },
            outputSchema: schema,
            ...(options?.model ? { model: options.model } : {}),
            ...(options?.reasoningEffort
              ? { effort: options.reasoningEffort }
              : {}),
          })
          .then((started) => {
            const turn = (started as { turn?: { id?: string } })?.turn;
            this.turnId = turn?.id ?? null;
            if (signal?.aborted) void this.cancel();
          })
          .catch((error: unknown) => {
            stop();
            clearTimeout(timer);
            reject(error);
          });
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.turnId = null;
      this.running = false;
    }
  }
  async cancel(): Promise<void> {
    if (this.turnId)
      await this.host
        .request("turn/interrupt", { threadId: this.id, turnId: this.turnId })
        .catch(() => undefined);
  }
  async closeSession(): Promise<void> {
    await this.cancel();
    this.events.end();
  }
}

class CodexHost implements LocalAgentProvider {
  readonly name = "codex";
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private listeners = new Set<(message: RpcMessage) => void>();
  readonly cwd = mkdtempSync(join(tmpdir(), "streamer-agent-"));
  status() {
    return runStatus("codex");
  }
  listen(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private async ensureStarted(): Promise<void> {
    if (this.child) return;
    const child = spawn(
      commandFor("codex"),
      ["app-server", "--listen", "stdio://"],
      {
        shell: false,
        windowsHide: true,
        cwd: this.cwd,
        env: childEnvironment(),
        stdio: "pipe",
      },
    );
    child.stderr.resume();
    this.child = child;
    child.once("error", (error) => this.failAll(error));
    child.once("exit", () => {
      this.child = null;
      this.failAll(new Error("Codex app-server exited."));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.length > 2_000_000) return;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(
            new Error(message.error.message ?? "Codex RPC failed."),
          );
        else pending.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
    try {
      await this.request("initialize", {
        clientInfo: {
          name: "streamer_ai",
          title: "StreamerAI",
          version: "0.1.0",
        },
      });
      child.stdin.write(
        `${JSON.stringify({ method: "initialized", params: {} })}\n`,
      );
    } catch (error) {
      child.kill();
      this.child = null;
      throw error;
    }
  }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin.writable)
      return Promise.reject(new Error("Codex app-server is unavailable."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: "host/exited" });
  }
  async startSession(sessionId?: string): Promise<AgentSession> {
    await this.ensureStarted();
    const result = await this.request(
      sessionId ? "thread/resume" : "thread/start",
      sessionId
        ? { threadId: sessionId }
        : { cwd: this.cwd, sandbox: "readOnly", approvalPolicy: "never" },
    );
    const id = (result as { thread?: { id?: string } })?.thread?.id;
    if (!id) throw new Error("Codex did not return a thread ID.");
    return new CodexSession(this, id);
  }
  async listModels(): Promise<AgentModelCatalog> {
    await this.ensureStarted();
    const models = new Map<string, ReturnType<typeof modelOption>>();
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const raw = await this.request("model/list", {
        limit: 50,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      const result =
        raw && typeof raw === "object"
          ? (raw as { data?: unknown[]; nextCursor?: unknown })
          : {};
      for (const row of result.data ?? []) {
        if (!row || typeof row !== "object") continue;
        const item = row as Record<string, unknown>;
        const id = typeof item.id === "string" ? item.id : item.model;
        if (
          typeof id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id)
        )
          continue;
        const declared = Array.isArray(item.supportedReasoningEfforts)
          ? item.supportedReasoningEfforts
              .map((entry) =>
                entry && typeof entry === "object"
                  ? (entry as Record<string, unknown>).reasoningEffort
                  : null,
              )
              .filter((value): value is ReasoningEffort =>
                REASONING_EFFORTS.includes(value as ReasoningEffort),
              )
          : undefined;
        if (declared && declared.length === 0) continue;
        models.set(
          id,
          modelOption(
            "codex",
            id,
            typeof item.displayName === "string" ? item.displayName : id,
            declared,
          ),
        );
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (!cursor || models.size >= 100) break;
    }
    if (!models.size) throw new Error("Codex returned no selectable models.");
    return {
      provider: "codex",
      models: [...models.values()],
      recommendedModel: recommendedModel("codex", [...models.values()]),
      source: "local",
      status: "available",
      message: "Models returned by this Codex installation and account.",
    };
  }
  async close(): Promise<void> {
    if (this.child) await stopChild(this.child);
    this.child = null;
    this.failAll(new Error("Codex host closed."));
    rmSync(this.cwd, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}

class ClaudeSession implements AgentSession {
  readonly events = new EventQueue();
  id: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  constructor(
    id: string | undefined,
    private readonly cwd: string,
  ) {
    this.id = id ?? "";
  }
  streamEvents(): AsyncIterable<LocalAgentEvent> {
    return this.events;
  }
  async sendMessage(
    message: string,
    schema: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { model?: string; reasoningEffort?: ReasoningEffort },
  ): Promise<string> {
    if (this.child)
      throw new Error("A Claude turn is already running in this session.");
    const args = [
      "--bare",
      "-p",
      message,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--json-schema",
      JSON.stringify(schema),
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
      "--permission-mode",
      "dontAsk",
    ];
    if (options?.model) args.push("--model", options.model);
    if (options?.reasoningEffort && options.reasoningEffort !== "none")
      args.push("--effort", options.reasoningEffort);
    if (this.id) args.push("--resume", this.id);
    const child = spawn(commandFor("claude"), args, {
      shell: false,
      windowsHide: true,
      cwd: this.cwd,
      env: childEnvironment(),
      stdio: "pipe",
    });
    child.stderr.resume();
    this.child = child;
    let result: string | null = null;
    let totalBytes = 0;
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 120_000);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      totalBytes += Buffer.byteLength(line);
      if (totalBytes > 2_000_000) {
        child.kill();
        return;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "stream_event") {
        const delta = (event.event as { delta?: { text?: string } } | undefined)
          ?.delta?.text;
        if (typeof delta === "string")
          this.events.push({ type: "delta", text: delta });
      }
      if (event.type === "result") {
        if (typeof event.session_id === "string") this.id = event.session_id;
        const output = event.structured_output ?? event.result;
        result = typeof output === "string" ? output : JSON.stringify(output);
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(`Claude exited with code ${code ?? "unknown"}.`),
              ),
        );
      });
      if (result === null) throw new Error("Claude returned no result.");
      this.events.push({ type: "completed", text: result, sessionId: this.id });
      return result;
    } catch (error) {
      this.events.push({
        type: "failed",
        message: error instanceof Error ? error.message : "Claude failed.",
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.child = null;
    }
  }
  async cancel(): Promise<void> {
    if (this.child) await stopChild(this.child);
  }
  async closeSession(): Promise<void> {
    await this.cancel();
    this.events.end();
  }
}

class ClaudeHost implements LocalAgentProvider {
  readonly name = "claude";
  private readonly cwd = mkdtempSync(join(tmpdir(), "streamer-agent-"));
  status() {
    return runStatus("claude");
  }
  async startSession(sessionId?: string): Promise<AgentSession> {
    return new ClaudeSession(sessionId, this.cwd);
  }
  async close(): Promise<void> {
    rmSync(this.cwd, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}

/** Owns one selected local provider; switching closes its sessions and process. */
export class LocalAgentHost {
  private provider: LocalAgentProvider | null = null;
  private sessions = new Map<string, AgentSession>();
  private transition: Promise<void> = Promise.resolve();
  private codexModels: { expires: number; catalog: AgentModelCatalog } | null =
    null;
  constructor(
    private readonly log: (event: {
      code: string;
      provider: LocalAgentName;
    }) => void = () => {},
  ) {}
  async status(name: LocalAgentName) {
    return runStatus(name);
  }
  cachedRecommendedModel(
    name: LocalAgentName,
    effort: ReasoningEffort = "low",
  ): string | null {
    return name === "claude"
      ? "haiku"
      : this.codexModels && this.codexModels.expires > Date.now()
        ? recommendedModel(name, this.codexModels.catalog.models, effort)
        : null;
  }
  async listModels(name: LocalAgentName): Promise<AgentModelCatalog> {
    if (
      name === "codex" &&
      this.codexModels &&
      this.codexModels.expires > Date.now()
    )
      return this.codexModels.catalog;
    const status = await this.status(name);
    if (name === "claude")
      return fallbackCatalog(
        "claude",
        status.available
          ? "Claude Code does not expose a machine-readable model list; the Haiku alias is suggested but not verified."
          : status.message,
      );
    if (!status.available)
      return {
        ...fallbackCatalog("codex", status.message),
        status: "unavailable",
      };
    return this.exclusive(async () => {
      let catalog: AgentModelCatalog;
      if (this.provider?.name === "codex") {
        try {
          catalog = await (this.provider as CodexHost).listModels();
        } catch {
          return fallbackCatalog(
            "codex",
            "Codex is signed in, but its model list could not be read.",
          );
        }
      } else {
        const host = new CodexHost();
        try {
          catalog = await host.listModels();
        } catch {
          return fallbackCatalog(
            "codex",
            "Codex is signed in, but its model list could not be read.",
          );
        } finally {
          await host.close();
        }
      }
      this.codexModels = { catalog, expires: Date.now() + 300_000 };
      return catalog;
    });
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.transition;
    let release!: () => void;
    this.transition = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
  private async closeUnlocked(): Promise<void> {
    const previous = this.provider?.name;
    for (const session of this.sessions.values()) await session.closeSession();
    this.sessions.clear();
    await this.provider?.close();
    this.provider = null;
    if (previous)
      this.log({ code: "LOCAL_AGENT_HOST_CLOSED", provider: previous });
  }
  async startSession(
    name: LocalAgentName,
    key: string,
    sessionId?: string,
  ): Promise<AgentSession> {
    return this.exclusive(async () => {
      if (this.provider?.name !== name) {
        await this.closeUnlocked();
        this.provider = name === "codex" ? new CodexHost() : new ClaudeHost();
        this.log({ code: "LOCAL_AGENT_HOST_SELECTED", provider: name });
      }
      const current = this.sessions.get(key);
      if (current) return current;
      const session = await this.provider.startSession(sessionId);
      this.sessions.set(key, session);
      this.log({ code: "LOCAL_AGENT_SESSION_STARTED", provider: name });
      return session;
    });
  }
  async close(): Promise<void> {
    await this.exclusive(() => this.closeUnlocked());
  }
}
