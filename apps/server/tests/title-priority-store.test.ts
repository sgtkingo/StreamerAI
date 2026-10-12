import { afterEach, describe, expect, it } from "vitest";
import { openStreamerDatabase } from "@streamer-ai/database";
import type { CatalogTitle } from "@streamer-ai/contracts";
import { TitlePriorityStore } from "../src/services/title-priority-store.js";

const databases: ReturnType<typeof openStreamerDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup() {
  let now = new Date("2026-10-11T12:00:00.000Z");
  const database = openStreamerDatabase({
    filename: ":memory:",
    clock: () => now,
  });
  databases.push(database);
  const store = new TitlePriorityStore(database, () => now);
  const title = {
    id: "series-1",
    availabilityCheckedAt: now.toISOString(),
  } as CatalogTitle;
  return {
    database,
    store,
    title,
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

describe("TitlePriorityStore", () => {
  it("keeps priority per profile and promotes frequent opens", () => {
    const { store } = setup();
    expect(store.priority("alice", "series-1")).toBe("low");
    store.opened("alice", "series-1");
    store.opened("alice", "series-1");
    expect(store.priority("alice", "series-1")).toBe("low");
    store.opened("alice", "series-1");
    expect(store.priority("alice", "series-1")).toBe("high");
    expect(store.priority("bob", "series-1")).toBe("low");
    expect(store.toggle("alice", "series-1")).toBe("low");
  });

  it("promotes starts of two distinct episodes", () => {
    const { store } = setup();
    store.played("alice", "series-1", { seasonNumber: 1, episodeNumber: 1 });
    store.played("alice", "series-1", { seasonNumber: 1, episodeNumber: 1 });
    expect(store.priority("alice", "series-1")).toBe("low");
    store.played("alice", "series-1", { seasonNumber: 1, episodeNumber: 2 });
    expect(store.priority("alice", "series-1")).toBe("high");
  });

  it("spaces low priority checks across a persisted daily window", () => {
    const { database, store, title, advance } = setup();
    expect(store.claimDue("alice", title)).toBe(false);
    advance(18 * 60 * 60_000);
    expect(store.claimDue("alice", title)).toBe(false);
    advance(12 * 60 * 60_000 + 1);
    expect(store.claimDue("alice", title)).toBe(true);
    expect(store.claimDue("alice", title)).toBe(false);
    const reloaded = new TitlePriorityStore(
      database,
      () => new Date("2026-10-12T18:00:00.001Z"),
    );
    expect(reloaded.claimDue("alice", title)).toBe(false);
  });

  it("checks a newly prioritized title immediately, then backs off from minutes to hours", () => {
    const { store, title, advance } = setup();
    expect(store.toggle("alice", title.id)).toBe("high");
    expect(store.claimDue("alice", title)).toBe(true);
    for (const minutes of [2, 4, 8, 16, 32, 64, 128, 240, 240]) {
      advance(minutes * 60_000 - 1);
      expect(store.claimDue("alice", title)).toBe(false);
      advance((Math.ceil(minutes * 0.25) + 1) * 60_000 + 1);
      expect(store.claimDue("alice", title)).toBe(true);
    }
  });

  it("starts the same rapid schedule when interactions promote a title", () => {
    const { store, title, advance } = setup();
    store.opened("alice", title.id);
    store.opened("alice", title.id);
    store.opened("alice", title.id);
    expect(store.claimDue("alice", title)).toBe(true);
    advance(3 * 60_000 + 1);
    expect(store.claimDue("alice", title)).toBe(true);
  });
});
