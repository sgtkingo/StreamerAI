import type { ProviderContext } from "@streamer-ai/contracts";
import { describe, expect, it, vi } from "vitest";
import { WebshareMediaProvider } from "../src/integrations/webshare-media-provider.js";
import type { WebshareClient } from "../src/integrations/webshare-client.js";
import { discoveryFailure } from "../src/services/discovery-diagnostics.js";
import { ProviderRequestError } from "../src/integrations/provider-http.js";

describe("discovery provider diagnostics", () => {
  it("records the exact Webshare search terms with correlation IDs and no credential reference", async () => {
    const events: Array<Record<string, unknown>> = [];
    const search = vi.fn(async () => ({ items: [] }));
    const provider = new WebshareMediaProvider({
      client: { forProfile: () => ({ search }) } as unknown as WebshareClient,
      issuePlaybackTicket: () => "private-ticket",
      diagnostic: (event) => events.push(event),
    });
    const context = {
      requestId: "discovery-123",
      profileId: "default",
      locale: "en",
      deadlineAt: "2099-01-01T00:00:00.000Z",
      secretRef: "private-credential-reference",
      discoverySessionId: "session-123",
    } as ProviderContext;
    const request = {
      titleId: "sai:tmdb:movie:687163",
      kind: "movie" as const,
      title: "Project Hail Mary",
      originalTitle: "Project Hail Mary",
      year: 2026,
      seasonNumber: null,
      episodeNumber: null,
      externalRefs: [],
      limit: 20,
    };
    await provider.search(request, context);
    await provider.search({ ...request, year: null }, context);
    expect(events).toEqual([
      expect.objectContaining({
        code: "DISCOVERY_PROVIDER_SEARCH",
        discoveryRequestId: "discovery-123",
        sessionId: "session-123",
        providerId: "webshare",
        query: "Project Hail Mary 2026",
      }),
      expect.objectContaining({
        code: "DISCOVERY_PROVIDER_SEARCH",
        query: "Project Hail Mary",
      }),
    ]);
    expect(search).toHaveBeenNthCalledWith(
      1,
      { query: "Project Hail Mary 2026", limit: 20 },
      undefined,
    );
    expect(JSON.stringify(events)).not.toContain(
      "private-credential-reference",
    );
    expect(JSON.stringify(events)).not.toContain("private-ticket");
  });

  it("classifies provider failures without copying exception messages", () => {
    const error = new ProviderRequestError("webshare", "forbidden", false, 403);
    error.message = "private-password";
    expect(discoveryFailure(error)).toMatchObject({
      providerId: "webshare",
      kind: "forbidden",
      retryable: false,
    });
    expect(JSON.stringify(discoveryFailure(error))).not.toContain(
      "private-password",
    );
  });
});
