import { describe, expect, it } from "vitest";
import {
  MediaSourcePreferencesSchema,
  orderMediaSources,
  resolveMediaSourceOrder,
} from "../src/index.js";

describe("media source preference contract", () => {
  it("defaults local storage first and appends new registered sources without resetting saved choices", () => {
    expect(
      resolveMediaSourceOrder([], ["webshare", "hellspy", "local-files"]),
    ).toEqual(["local-files", "webshare", "hellspy"]);
    expect(
      resolveMediaSourceOrder(
        ["hellspy", "local-files", "removed"],
        ["webshare", "hellspy", "local-files", "new-media"],
      ),
    ).toEqual(["hellspy", "local-files", "webshare", "new-media"]);
  });
  it("orders by provider while preserving the quality ordering within each provider", () => {
    const sources = [
      { providerId: "webshare", resolution: 2160 },
      { providerId: "local-files", resolution: 720 },
      { providerId: "webshare", resolution: 1080 },
    ];
    expect(orderMediaSources(sources, ["local-files", "webshare"])).toEqual([
      sources[1],
      sources[0],
      sources[2],
    ]);
    expect(sources[0]?.providerId).toBe("webshare");
  });
  it("rejects duplicates, malformed IDs and unexpected fields", () => {
    for (const value of [
      { providerOrder: ["webshare", "webshare"] },
      { providerOrder: ["../private"] },
      { providerOrder: [], token: "private" },
    ]) {
      expect(MediaSourcePreferencesSchema.safeParse(value).success).toBe(false);
    }
  });
});
