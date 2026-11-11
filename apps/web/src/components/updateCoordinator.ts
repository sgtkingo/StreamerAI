import { UpdateSaveError } from "./updateSave";

type Connection = Pick<BroadcastChannel, "postMessage" | "close" | "onmessage">;
type Message = {
  kind: "query" | "status" | "leave" | "prepare" | "prepared" | "cancel";
  id: string;
  protocol?: number;
  request?: string;
  busy?: boolean;
  ok?: boolean;
};
const TIMEOUT = 30_000;

/** Messages contain coordination metadata only, never form data or credentials. */
export class UpdateCoordinator {
  private readonly id = crypto.randomUUID();
  private readonly peers = new Map<
    string,
    { protocol: number; busy: boolean }
  >();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private request: string | null = null;
  private leader: string | null = null;
  private replies: Map<string, boolean | null> | null = null;
  private changed: (() => void) | null = null;
  private disposed = false;
  private preparation: AbortController | null = null;
  private prepared = false;

  constructor(
    private readonly options: {
      connection: Connection | null;
      prepare: (signal?: AbortSignal) => Promise<void>;
      busy: () => boolean;
      onBusy: (busy: boolean) => void;
      onError?: (reason: unknown) => void;
    },
  ) {
    if (options.connection)
      options.connection.onmessage = (event: MessageEvent<unknown>) => {
        void this.receive(event.data);
      };
    this.publish();
    this.send({ kind: "query" });
    this.heartbeat = setInterval(() => this.publish(), 2000);
  }

  private send(message: Omit<Message, "id" | "protocol">) {
    if (!this.disposed)
      this.options.connection?.postMessage({
        ...message,
        id: this.id,
        protocol: 2,
      });
  }

  private publish() {
    this.send({ kind: "status", busy: this.options.busy() });
  }

  private release() {
    this.preparation?.abort();
    this.preparation = null;
    this.request = null;
    this.leader = null;
    this.prepared = false;
    this.options.onBusy(false);
  }

  private async receive(data: unknown) {
    if (!data || typeof data !== "object" || this.disposed) return;
    const message = data as Partial<Message>;
    if (
      typeof message.id !== "string" ||
      message.id.length > 100 ||
      message.id === this.id
    )
      return;
    if (message.kind === "query") this.publish();
    if (
      message.kind === "status" &&
      typeof message.busy === "boolean" &&
      (this.peers.has(message.id) || this.peers.size < 50)
    ) {
      this.peers.set(message.id, {
        protocol: message.protocol === 2 ? 2 : 1,
        busy: message.busy,
      });
      if (
        message.protocol === 2 &&
        this.request &&
        !this.leader &&
        this.replies &&
        !this.replies.has(message.id)
      ) {
        this.replies.set(message.id, null);
        this.send({ kind: "prepare", request: this.request });
      }
    }
    if (message.kind === "leave") {
      this.peers.delete(message.id);
      this.replies?.delete(message.id);
      this.changed?.();
      if (this.leader === message.id) this.release();
    }
    if (typeof message.request !== "string" || message.request.length > 100)
      return;
    if (
      message.kind === "cancel" &&
      message.request === this.request &&
      message.id === this.leader
    )
      this.release();
    if (
      message.kind === "prepared" &&
      message.request === this.request &&
      this.replies?.has(message.id)
    ) {
      this.replies.set(message.id, message.ok === true);
      this.changed?.();
    }
    if (message.kind !== "prepare" || message.protocol !== 2) return;
    if (this.request) {
      if (this.request !== message.request)
        this.send({ kind: "prepared", request: message.request, ok: false });
      else if (this.prepared && this.leader === message.id)
        this.send({ kind: "prepared", request: message.request, ok: true });
      return;
    }
    this.request = message.request;
    this.leader = message.id;
    const preparation = new AbortController();
    this.preparation = preparation;
    this.options.onBusy(true);
    try {
      await this.options.prepare(preparation.signal);
      if (this.request === message.request) {
        this.prepared = true;
        this.send({ kind: "prepared", request: message.request, ok: true });
      }
    } catch (reason) {
      if (this.request !== message.request || this.preparation !== preparation)
        return;
      const cancelled = preparation.signal.aborted;
      this.send({ kind: "prepared", request: message.request, ok: false });
      this.release();
      if (!cancelled) this.options.onError?.(reason);
    }
  }

  private waitForReplies() {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.changed = null;
        reject(
          new UpdateSaveError(
            "Another StreamerAI tab did not finish saving. Bring it into view and try again.",
          ),
        );
      }, TIMEOUT);
      this.changed = () => {
        const replies = [...(this.replies?.values() ?? [])];
        if (replies.some((ok) => ok === false)) {
          clearTimeout(timeout);
          this.changed = null;
          reject(
            new UpdateSaveError(
              "Changes in another StreamerAI tab could not be saved. Check that tab and try again.",
            ),
          );
        } else if (replies.every((ok) => ok === true)) {
          clearTimeout(timeout);
          this.changed = null;
          resolve();
        }
      };
      this.changed();
    });
  }

  async apply(activate: () => Promise<void>) {
    if (this.request) return;
    const request = crypto.randomUUID();
    this.request = request;
    const preparation = new AbortController();
    this.preparation = preparation;
    this.options.onBusy(true);
    try {
      this.send({ kind: "query" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (
        [...this.peers.values()].some((peer) => peer.protocol < 2 && peer.busy)
      )
        throw new UpdateSaveError(
          "An older StreamerAI tab has unfinished work. Finish it there, then try updating again.",
        );
      // Updated peers save automatically; old, clean peers have no work to save.
      const expected = [...this.peers]
        .filter(([, peer]) => peer.protocol === 2)
        .map(([id]) => id);
      this.replies = new Map(expected.map((id) => [id, null]));
      if (expected.length) this.send({ kind: "prepare", request });
      await this.waitForReplies();
      // Save the tab where Update was clicked last, so its edits take precedence.
      await this.options.prepare(preparation.signal);
      if (this.disposed || this.request !== request) return;
      // A tab opened while local saves were running must also finish preparing.
      await this.waitForReplies();
      await activate();
    } catch (error) {
      this.send({ kind: "cancel", request });
      this.release();
      throw error;
    } finally {
      this.replies = null;
    }
  }

  dispose() {
    this.send({ kind: "leave" });
    this.preparation?.abort();
    this.disposed = true;
    clearInterval(this.heartbeat);
    this.options.connection?.close();
  }
}
