import { describe, expect, it } from "vitest";
import { createApp, InMemoryPlaybackTicketStore } from "../src/index.js";
import { validatePlaybackSourceUrl } from "../src/services/playback-ticket-store.js";

describe("ephemeral playback tickets", () => {
  it("allows secure media URLs and loopback HTTP but rejects other schemes", () => {
    expect(validatePlaybackSourceUrl("https://media.example/video.mp4")).toBe(
      "https://media.example/video.mp4",
    );
    expect(validatePlaybackSourceUrl("http://127.0.0.1:8080/video.mp4")).toBe(
      "http://127.0.0.1:8080/video.mp4",
    );
    expect(() =>
      validatePlaybackSourceUrl("ftp://127.0.0.1/video.mp4"),
    ).toThrow();
    expect(() =>
      validatePlaybackSourceUrl("file:///private/video.mp4"),
    ).toThrow();
    expect(() =>
      validatePlaybackSourceUrl(
        "https://user:password@media.example/video.mp4",
      ),
    ).toThrow();
  });

  it("keeps exactly one direct URL in memory without exposing it through the grant path", async () => {
    const now = () => new Date("2026-09-28T12:00:00.000Z");
    const store = new InMemoryPlaybackTicketStore(now);
    const firstPath = store.issue({
      grantId: "grant-one",
      profileId: "default",
      providerId: "webshare",
      titleId: "title-1",
      variantId: "file-1",
      directUrl: "https://cdn.webshare.cz/first",
      expiresAt: "2026-09-28T12:01:00.000Z",
    });
    const secondPath = store.issue({
      grantId: "grant-two",
      profileId: "default",
      providerId: "webshare",
      titleId: "sai:preview:lake-house",
      variantId: "file-2",
      directUrl: "https://cdn.webshare.cz/second",
      expiresAt: "2026-09-28T12:01:00.000Z",
    });
    expect(store.get("grant-one")).toBeNull();
    expect(firstPath).toBe("/api/v1/playback/grants/grant-one");

    const app = createApp({
      environment: "test",
      logger: false,
      now,
      playbackTicketStore: store,
    });
    const direct = await app.inject({ method: "GET", url: secondPath });
    expect(direct.statusCode).toBe(404);
    expect(direct.headers.location).toBeUndefined();
    expect(direct.body).not.toContain("https://cdn.webshare.cz/second");
    const history = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/default/history",
    });
    expect(history.json().items).toHaveLength(0);
    await app.inject({ method: "GET", url: secondPath });
    const historyAfterReload = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/default/history",
    });
    expect(historyAfterReload.json().items).toHaveLength(0);
    await app.close();
  });
});
