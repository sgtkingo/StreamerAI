import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateCoordinator } from "./updateCoordinator";

class Channel {
  static peers = new Set<Channel>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor() {
    Channel.peers.add(this);
  }
  postMessage(data: unknown) {
    for (const peer of Channel.peers) {
      if (peer !== this)
        queueMicrotask(() =>
          peer.onmessage?.({ data } as MessageEvent<unknown>),
        );
    }
  }
  close() {
    Channel.peers.delete(this);
  }
}
const controllers: UpdateCoordinator[] = [];
function tab(prepare = vi.fn(async () => undefined)) {
  const connection = new Channel();
  const onBusy = vi.fn();
  const controller = new UpdateCoordinator({
    connection,
    prepare,
    busy: () => true,
    onBusy,
  });
  controllers.push(controller);
  return { controller, connection, onBusy, prepare };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  Channel.peers.clear();
  vi.useRealTimers();
});

it("also prepares a tab opened while the initiating tab is still saving", async () => {
  let finishLocal!: () => void;
  let finishSibling!: () => void;
  const first = tab(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLocal = resolve;
        }),
    ),
  );
  const activate = vi.fn(async () => undefined);
  const operation = first.controller.apply(activate);
  await vi.advanceTimersByTimeAsync(300);
  const sibling = tab(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSibling = resolve;
        }),
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(sibling.prepare).toHaveBeenCalledOnce();
  finishLocal();
  await vi.advanceTimersByTimeAsync(0);
  expect(activate).not.toHaveBeenCalled();
  finishSibling();
  await operation;
  expect(activate).toHaveBeenCalledOnce();
});

it("automatically saves sibling tabs before saving the initiating tab and activating", async () => {
  const order: string[] = [];
  const first = tab(
    vi.fn(async () => {
      order.push("current");
    }),
  );
  const sibling = tab(
    vi.fn(async () => {
      order.push("sibling");
    }),
  );
  const activate = vi.fn(async () => {
    order.push("activate");
  });
  const operation = first.controller.apply(activate);
  await vi.advanceTimersByTimeAsync(300);
  await operation;
  expect(order).toEqual(["sibling", "current", "activate"]);
  expect(sibling.onBusy).toHaveBeenLastCalledWith(true);
});

it("waits for asynchronous saves in another tab", async () => {
  let finish!: () => void;
  const first = tab();
  tab(
    vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const activate = vi.fn(async () => undefined);
  const operation = first.controller.apply(activate);
  await vi.advanceTimersByTimeAsync(300);
  expect(activate).not.toHaveBeenCalled();
  finish();
  await operation;
  expect(activate).toHaveBeenCalledOnce();
});

it("cancels and releases every tab when one save fails", async () => {
  const first = tab();
  const sibling = tab(
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
  const third = tab();
  const activate = vi.fn(async () => undefined);
  const result = first.controller
    .apply(activate)
    .catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(300);
  expect(((await result) as Error).message).toMatch(
    /another StreamerAI tab could not be saved/,
  );
  expect(activate).not.toHaveBeenCalled();
  expect(first.onBusy).toHaveBeenLastCalledWith(false);
  expect(sibling.onBusy).toHaveBeenLastCalledWith(false);
  expect(third.onBusy).toHaveBeenLastCalledWith(false);
});

it("stops when a known tab does not acknowledge saving", async () => {
  const first = tab();
  const silent = new Channel();
  silent.postMessage({
    id: "silent",
    kind: "status",
    protocol: 2,
    busy: false,
  });
  await vi.advanceTimersByTimeAsync(0);
  const activate = vi.fn(async () => undefined);
  const result = first.controller
    .apply(activate)
    .catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(30_300);
  expect(((await result) as Error).message).toMatch(/did not finish saving/);
  expect(activate).not.toHaveBeenCalled();
  expect(first.onBusy).toHaveBeenLastCalledWith(false);
});

it("protects unfinished work in a tab still using the old update protocol", async () => {
  const first = tab();
  const old = new Channel();
  old.postMessage({ id: "old", kind: "status", busy: true });
  await vi.advanceTimersByTimeAsync(0);
  const activate = vi.fn(async () => undefined);
  const result = first.controller
    .apply(activate)
    .catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(300);
  expect(((await result) as Error).message).toMatch(/older StreamerAI tab/);
  expect(activate).not.toHaveBeenCalled();
});

it("ignores duplicate clicks while an update is being prepared", async () => {
  const first = tab();
  const activate = vi.fn(async () => undefined);
  const operation = first.controller.apply(activate);
  await first.controller.apply(activate);
  await vi.advanceTimersByTimeAsync(300);
  await operation;
  expect(activate).toHaveBeenCalledOnce();
});
