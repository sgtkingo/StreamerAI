import { AsyncLocalStorage } from "node:async_hooks";

const displayHeightContext = new AsyncLocalStorage<number>();

export function withRequestDisplayHeight(raw: unknown, next: () => void): void {
  const value = typeof raw === "string" ? Number(raw) : NaN;
  const height =
    Number.isInteger(value) && value >= 240 && value <= 4320 ? value : 1080;
  displayHeightContext.run(height, next);
}

export function requestDisplayHeight(): number {
  return displayHeightContext.getStore() ?? 1080;
}
