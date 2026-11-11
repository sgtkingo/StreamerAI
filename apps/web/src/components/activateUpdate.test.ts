import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activateUpdate } from "./activateUpdate";

class WaitingWorker extends EventTarget {
  state = "installed";
  postMessage = vi.fn();
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("waits for real activation and retries messages while the worker is still waiting", async () => {
  const worker = new WaitingWorker();
  vi.stubGlobal("navigator", {
    serviceWorker: { getRegistration: async () => ({ waiting: worker }) },
  });
  const trigger = vi.fn(async () => undefined);
  let finished = false;
  const operation = activateUpdate(trigger).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(trigger).not.toHaveBeenCalled();
  expect(finished).toBe(false);
  expect(worker.postMessage).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  worker.state = "activated";
  worker.dispatchEvent(new Event("statechange"));
  await operation;
  expect(finished).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
});

it("reports a redundant worker and stops retries", async () => {
  const worker = new WaitingWorker();
  vi.stubGlobal("navigator", {
    serviceWorker: { getRegistration: async () => ({ waiting: worker }) },
  });
  const result = activateUpdate(async () => undefined).catch(
    (error: Error) => error,
  );
  await vi.advanceTimersByTimeAsync(0);
  worker.state = "redundant";
  worker.dispatchEvent(new Event("statechange"));
  expect(((await result) as Error).message).toMatch(/could not be activated/);
  await vi.advanceTimersByTimeAsync(5000);
  expect(worker.postMessage).toHaveBeenCalledOnce();
});
