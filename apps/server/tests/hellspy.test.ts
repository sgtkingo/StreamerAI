import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertConnectorDescriptor,
  MediaCandidateSchema,
  MediaVariantSchema,
  type MediaSearchRequest,
  type ProviderContext,
} from "@streamer-ai/contracts";
import {
  createApp,
  createAppLogger,
  HellspyClient,
  HellspyMediaProvider,
  HELLSPY_SESSION_SECRET_KEY,
  NonPersistentMemorySecretStore,
  NonPersistentMemoryIntegrationStateStore,
  InMemoryPlaybackTicketStore,
  type ProviderFetch,
} from "../src/index.js";
import { profileSecretKey } from "../src/stores/secret-store.js";

const now = () => new Date("2026-10-25T12:00:00.000Z");
const session = {
  accessToken: "private-account-token",
  expires: "2026-10-26T12:00:00.000Z",
};
const identity = {
  token: { id: 1 },
  user: { id: 2 },
  client: { id: 3 },
  admin: null,
};
const video = {
  id: 2461091,
  title: "Big_Buck_Bunny_1080p",
  fileHash: "84864e299028473a",
  size: 928670754,
};
const candidate = {
  providerId: "hellspy",
  candidateId: "2461091:84864e299028473a",
};
const directUrl =
  "https://sixseven.onecdn1.net/file.mp4?token=private-stream-token";
const detail = {
  ...video,
  filename: "Big_Buck_Bunny_1080p.avi",
  conversions: { "480": directUrl, "1080": directUrl },
  subtitles: [],
};
const context: ProviderContext = {
  requestId: "hellspy-test",
  profileId: "default",
  locale: "cs",
  deadlineAt: "2099-01-01T00:00:00.000Z",
  secretRef: null,
};
const query: MediaSearchRequest = {
  titleId: "bunny",
  kind: "movie",
  title: "Big Buck Bunny",
  originalTitle: null,
  year: 2008,
  seasonNumber: null,
  episodeNumber: null,
  externalRefs: [],
  limit: 5,
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
function transport() {
  return vi.fn<ProviderFetch>(async (url) => {
    if (url.endsWith("/login") || url.endsWith("/refresh_token"))
      return json(session);
    if (url.endsWith("/identify")) return json(identity);
    if (url.includes("/gw/search?")) return json({ items: [video] });
    if (url.includes("/gw/video/")) return json(detail);
    if (url.startsWith("https://sixseven.onecdn1.net/"))
      return new Response("x", {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": "bytes 0-0/315813828",
        },
      });
    throw new Error("Unexpected request");
  });
}
async function fixture() {
  const secrets = new NonPersistentMemorySecretStore();
  await secrets.set(HELLSPY_SESSION_SECRET_KEY, JSON.stringify(session));
  const fetch = transport();
  const client = new HellspyClient({ secretStore: secrets, fetch, now });
  const tickets = new InMemoryPlaybackTicketStore(now);
  const issue = vi.fn((input) => tickets.issue(input));
  const provider = new HellspyMediaProvider({
    client,
    now,
    issuePlaybackTicket: issue,
  });
  return { secrets, fetch, client, tickets, provider, issue };
}

describe("Hellspy authenticated media adapter", () => {
  it("normalizes real API shapes, opaque IDs and provenance without exposing signed URLs", async () => {
    const { provider } = await fixture();
    expect(
      assertConnectorDescriptor(provider.descriptor(), "media").contractVersion,
    ).toBe(1);
    const results = await provider.search(query, context);
    expect(MediaCandidateSchema.parse(results[0])).toMatchObject({
      ref: candidate,
      confidence: 0.5,
      provenance: { validationState: "derived" },
    });
    const variant = MediaVariantSchema.parse(
      await provider.inspect(candidate, context),
    );
    expect(variant).toMatchObject({
      variantId: `${candidate.candidateId}:1080`,
      format: { resolution: "1080p", container: "mp4", videoCodec: null },
    });
    expect(JSON.stringify([results, variant])).not.toContain("private-");
  });
  it("queries episodes without the series premiere year, including alternate episode terms", async () => {
    const { provider, fetch } = await fixture();
    await provider.search(
      {
        ...query,
        kind: "series",
        seasonNumber: 2,
        episodeNumber: 3,
        episodeSearchTerm: "2x03",
      },
      context,
    );
    const call = fetch.mock.calls.find(([url]) => url.includes("/gw/search?"))!;
    expect(new URL(call[0]).searchParams.get("query")).toBe(
      "Big Buck Bunny 2x03",
    );
    expect(call[1].headers.Authorization).toBe(`Bearer ${session.accessToken}`);
    expect(call[1].redirect).toBe("manual");
  });
  it("issues a same-origin grant after a byte-range check and refreshes the exact conversion", async () => {
    const { provider, tickets, fetch, issue } = await fixture();
    const variant = await provider.inspect(candidate, context);
    const grant = await provider.createPlayback(
      {
        profileId: "default",
        titleId: "bunny",
        variant: { ...candidate, variantId: variant.variantId },
        startPositionSeconds: 0,
      },
      context,
    );
    expect(grant.url).toMatch(/^\/api\/v1\/playback\/grants\//);
    expect(grant.supportsHttpRange).toBe(true);
    expect(tickets.get(grant.grantId)).toMatchObject({
      directUrl,
      providerId: "hellspy",
      sourceSizeBytes: null,
    });
    expect(JSON.stringify(grant)).not.toContain("private-");
    const probe = fetch.mock.calls.find(([url]) => url === directUrl)!;
    expect(probe[1].headers).toMatchObject({ Range: "bytes=0-0" });
    expect(probe[1].headers.Authorization).toBeUndefined();
    expect(
      await provider.refreshPlaybackSource(
        { candidate, variantId: variant.variantId },
        context,
      ),
    ).toBe(directUrl);
    await expect(
      provider.createPlayback(
        {
          profileId: "another",
          titleId: "bunny",
          variant: { ...candidate, variantId: variant.variantId },
          startPositionSeconds: 0,
        },
        context,
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(issue).toHaveBeenCalledOnce();
  });
  it("prefers an original when available and never swaps a missing selected quality", async () => {
    const { provider, fetch } = await fixture();
    fetch.mockImplementation(async (url) =>
      url.endsWith("/identify")
        ? json(identity)
        : json({
            ...detail,
            conversions: { "0": directUrl, "1080": directUrl },
          }),
    );
    expect(await provider.inspect(candidate, context)).toMatchObject({
      variantId: `${candidate.candidateId}:0`,
      format: { container: "avi", resolution: null },
    });
    await expect(
      provider.refreshPlaybackSource(
        { candidate, variantId: `${candidate.candidateId}:720` },
        context,
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });
  it("rejects anonymous HTTP 200 identities, expired tokens and another profile before searching", async () => {
    const { client, secrets, fetch } = await fixture();
    await expect(client.search("other", "Bunny", 2)).rejects.toMatchObject({
      kind: "not-configured",
    });
    expect(fetch).not.toHaveBeenCalled();
    await secrets.set(
      HELLSPY_SESSION_SECRET_KEY,
      JSON.stringify({ ...session, expires: "2026-10-24T12:00:00.000Z" }),
    );
    await expect(client.search("default", "Bunny", 2)).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(fetch).not.toHaveBeenCalled();
    await secrets.set(HELLSPY_SESSION_SECRET_KEY, JSON.stringify(session));
    fetch.mockResolvedValue(
      json({ token: null, user: null, client: null, admin: null }),
    );
    await expect(client.search("default", "Bunny", 2)).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("refreshes expiring sessions once for concurrent requests and saves no password", async () => {
    const { client, secrets, fetch } = await fixture();
    await secrets.set(
      HELLSPY_SESSION_SECRET_KEY,
      JSON.stringify({ ...session, expires: "2026-10-25T12:01:00.000Z" }),
    );
    await Promise.all([
      client.authorize("default"),
      client.authorize("default"),
    ]);
    expect(
      fetch.mock.calls.filter(([url]) => url.endsWith("/refresh_token")),
    ).toHaveLength(1);
    expect(
      JSON.parse((await secrets.get(HELLSPY_SESSION_SECRET_KEY))!),
    ).toEqual(session);
  });
  it("does not restore a token when disconnected during an in-flight refresh", async () => {
    const { client, secrets, fetch } = await fixture();
    await secrets.set(
      HELLSPY_SESSION_SECRET_KEY,
      JSON.stringify({ ...session, expires: "2026-10-25T12:01:00.000Z" }),
    );
    fetch.mockImplementation(async (url) => {
      if (url.endsWith("/refresh_token")) {
        await secrets.delete(HELLSPY_SESSION_SECRET_KEY);
        return json(session);
      }
      return json(identity);
    });
    await expect(client.authorize("default")).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(await secrets.has(HELLSPY_SESSION_SECRET_KEY)).toBe(false);
  });
  it.each([
    "https://127.0.0.1/private",
    "http://sixseven.onecdn1.net/file",
    "https://onecdn1.net.attacker.test/file",
    "https://user:pass@sixseven.onecdn1.net/file",
    "https://sixseven.onecdn1.net:444/file",
  ])("rejects untrusted media URL %s before probing", async (url) => {
    const { provider, fetch, issue } = await fixture();
    fetch.mockImplementation(async (input) =>
      input.endsWith("/identify")
        ? json(identity)
        : json({ ...detail, conversions: { "1080": url } }),
    );
    await expect(provider.inspect(candidate, context)).rejects.toMatchObject({
      kind: "invalid-response",
    });
    expect(
      fetch.mock.calls.every(([input]) =>
        input.startsWith("https://api.hellspy.to/"),
      ),
    ).toBe(true);
    expect(issue).not.toHaveBeenCalled();
  });
  it("distinguishes an empty search from malformed or failed provider data", async () => {
    const { client, fetch } = await fixture();
    fetch.mockImplementation(async (url) =>
      url.endsWith("/identify") ? json(identity) : json({ items: [] }),
    );
    expect(await client.search("default", "unknown", 5)).toEqual([]);
    fetch.mockImplementation(async (url) =>
      url.endsWith("/identify") ? json(identity) : json({ items: [{ id: 1 }] }),
    );
    await expect(client.search("default", "unknown", 5)).rejects.toMatchObject({
      kind: "invalid-response",
    });
    fetch.mockImplementation(async (url) =>
      url.endsWith("/identify")
        ? json(identity)
        : json({ error: "private upstream message" }, 503),
    );
    await expect(client.search("default", "unknown", 5)).rejects.toMatchObject({
      kind: "upstream",
    });
  });
  it("bounds responses, refuses redirects and backs off after rate limiting", async () => {
    const { client, fetch } = await fixture();
    fetch.mockImplementation(
      async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    );
    await expect(client.authorize("default")).rejects.toMatchObject({
      kind: "invalid-response",
    });
    fetch.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.test/" },
        }),
    );
    await expect(client.authorize("default")).rejects.toMatchObject({
      kind: "upstream",
    });
    fetch.mockImplementation(async () => json({}, 429));
    await expect(client.authorize("default")).rejects.toMatchObject({
      kind: "rate-limited",
    });
    const count = fetch.mock.calls.length;
    await expect(client.authorize("default")).rejects.toMatchObject({
      kind: "rate-limited",
    });
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  it("times out safely and honors cancellation", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(HELLSPY_SESSION_SECRET_KEY, JSON.stringify(session));
    const fetch: ProviderFetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("private payload", "AbortError")),
          { once: true },
        );
      });
    const client = new HellspyClient({
      secretStore: secrets,
      fetch,
      now,
      timeoutMs: 5,
    });
    await expect(client.authorize("default")).rejects.toMatchObject({
      kind: "timeout",
    });
    const controller = new AbortController();
    const task = client.authorize("default", controller.signal);
    controller.abort();
    await expect(task).rejects.toThrow();
  });
});

describe("Hellspy guided connection lifecycle", () => {
  const apps: ReturnType<typeof createApp>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  function app(
    fetch = transport(),
    secrets = new NonPersistentMemorySecretStore(),
    states = new NonPersistentMemoryIntegrationStateStore(),
  ) {
    const logs: string[] = [];
    const instance = createApp({
      environment: "test",
      logger: createAppLogger({
        destination: {
          write: (line) => {
            logs.push(line);
          },
        },
      }),
      providerFetch: fetch,
      secretStore: secrets,
      integrationStateStore: states,
      now,
      inferenceFetch: async () => {
        throw new Error("offline test runtime");
      },
    });
    apps.push(instance);
    return { instance, secrets, states, logs, fetch };
  }
  it("verifies before storing, exposes a usable catalog source, rechecks and disconnects", async () => {
    const { instance, secrets, logs, states } = app();
    const connect = await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/hellspy/connect",
      payload: {
        username: "viewer@example.test",
        password: "private-password",
      },
    });
    expect(connect.statusCode).toBe(200);
    expect(connect.json()).toMatchObject({
      integrationId: "hellspy",
      ok: true,
      persistence: "memory",
    });
    expect(
      JSON.parse((await secrets.get(HELLSPY_SESSION_SECRET_KEY))!),
    ).toEqual(session);
    const catalog = await instance.inject("/api/v1/integrations");
    expect(
      catalog
        .json()
        .items.find((item: { id: string }) => item.id === "hellspy"),
    ).toMatchObject({
      planned: false,
      configured: true,
      setup: { mode: "credentials" },
    });
    const setup = await instance.inject("/api/v1/setup/status");
    expect(setup.json().capabilities.playback).toBe(true);
    const check = await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/hellspy/check",
      payload: {},
    });
    expect(check.json().ok).toBe(true);
    await secrets.set(
      profileSecretKey("other", HELLSPY_SESSION_SECRET_KEY),
      "other-profile-session",
    );
    const disconnect = await instance.inject({
      method: "DELETE",
      url: "/api/v1/integrations/hellspy",
    });
    expect(disconnect.statusCode).toBe(204);
    expect(await secrets.has(HELLSPY_SESSION_SECRET_KEY)).toBe(false);
    expect(
      await secrets.has(profileSecretKey("other", HELLSPY_SESSION_SECRET_KEY)),
    ).toBe(true);
    expect(await states.get("hellspy")).toBeUndefined();
    expect(
      [connect.body, catalog.body, setup.body, ...logs].join(""),
    ).not.toMatch(
      /private-password|private-account-token|integration\.hellspy\.session/,
    );
  });
  it("does not save rejected logins, and a failed recheck disables the source", async () => {
    const { instance, secrets, fetch, states } = app();
    fetch.mockImplementation(async () =>
      json({ error: "private-password" }, 401),
    );
    const rejected = await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/hellspy/connect",
      payload: {
        username: "viewer@example.test",
        password: "private-password",
      },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body).not.toContain("private-password");
    expect(await secrets.has(HELLSPY_SESSION_SECRET_KEY)).toBe(false);
    await secrets.set(HELLSPY_SESSION_SECRET_KEY, JSON.stringify(session));
    const check = await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/hellspy/check",
      payload: {},
    });
    expect(check.statusCode).toBe(401);
    expect(await states.get("hellspy")).toMatchObject({
      configured: false,
      status: "action_required",
    });
  });
  it("rolls back the previous session if persisting connection state fails", async () => {
    const { instance, secrets, states } = app();
    await instance.ready();
    await secrets.set(HELLSPY_SESSION_SECRET_KEY, "previous-session");
    vi.spyOn(states, "set").mockRejectedValue(new Error("storage error"));
    const result = await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/hellspy/connect",
      payload: {
        username: "viewer@example.test",
        password: "private-password",
      },
    });
    expect(result.statusCode).toBe(500);
    expect(result.json().messageCode).toBe("SECURE_STORAGE_UNAVAILABLE");
    expect(await secrets.get(HELLSPY_SESSION_SECRET_KEY)).toBe(
      "previous-session",
    );
  });
  it("rejects unknown profiles and malformed credentials without contacting the provider", async () => {
    const { instance, fetch } = app();
    for (const payload of [
      { username: "invalid", password: "secret" },
      {
        username: "viewer@example.test",
        password: "secret",
        profileId: "missing",
      },
    ]) {
      const response = await instance.inject({
        method: "POST",
        url: "/api/v1/integrations/hellspy/connect",
        payload,
      });
      expect([400, 404]).toContain(response.statusCode);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
