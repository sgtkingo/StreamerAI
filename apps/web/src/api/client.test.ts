import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

it("rechecks browser pairing when its installation authorization expires", async () => {
  const expired = vi.fn();
  window.addEventListener("streamer:auth-required", expired);
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "INSTALLATION_ACCESS_REQUIRED" } }),
        { status: 401 },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(apiClient.getProfiles()).rejects.toMatchObject({
      code: "INSTALLATION_ACCESS_REQUIRED",
      message: expect.stringContaining("Connect this browser"),
    });
    expect(expired).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/profiles",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  } finally {
    window.removeEventListener("streamer:auth-required", expired);
  }
});
