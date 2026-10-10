import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type {
  SubtitleAsset,
  SubtitleCandidate,
  SubtitleProvider,
} from "@streamer-ai/contracts";
import { AdapterRegistry } from "../src/integrations/provider-registry.js";
import { registerPlaybackRoutes } from "../src/routes/playback.js";
import { MultiSourceExternalSubtitleService } from "../src/services/multi-source-subtitle-service.js";
import { InMemoryPlaybackTicketStore } from "../src/services/playback-ticket-store.js";
import type { PlaybackMediaEngine } from "../src/services/playback-media-engine.js";
import type { StreamerCore } from "../src/services/streamer-core.js";

const retrievedAt = "2026-10-10T12:00:00.000Z";
const content = "1\n00:00:02,000 --> 00:00:04,000\nHello\n";

function candidate(
  providerId: string,
  candidateId: string,
  releaseName: string | null = "Film.2020.S01E02",
): SubtitleCandidate {
  return {
    ref: { providerId, candidateId },
    language: "en",
    format: "srt",
    releaseName,
    hearingImpaired: false,
    matchConfidence: 0.93,
    provenance: {
      providerId,
      retrievedAt,
      connectorVersion: "1.0.0",
      confidence: 0.9,
      validationState: "verified",
      expiresAt: null,
    },
  };
}

function subtitleProvider(
  id: string,
  search: SubtitleProvider["search"],
  fetch: SubtitleProvider["fetch"] = vi.fn(),
): SubtitleProvider {
  return {
    descriptor: () => ({
      id,
      family: "subtitle",
      displayName: id,
      connectorVersion: "1.0.0",
      capabilities: ["episode-search", "srt"],
      supportedLocales: ["en"],
      setupMode: "none",
      credentialFields: [],
      canAutoDetect: false,
      supportsRecheck: true,
      supportsDisconnect: false,
      documentationUrl: null,
      privacySummary: "Searches subtitles for the selected media.",
    }),
    health: vi.fn(),
    search,
    fetch,
  };
}

function ticket() {
  const tickets = new InMemoryPlaybackTicketStore();
  tickets.issue({
    grantId: "subtitle-grant",
    profileId: "default",
    providerId: "webshare",
    titleId: "film",
    seasonNumber: 1,
    episodeNumber: 2,
    variantId: "media-1",
    directUrl: "https://media.example/film",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceFilename: "Film.2020.S01E02.mkv",
  });
  return { tickets, record: tickets.get("subtitle-grant")! };
}

function service(
  providers: SubtitleProvider[],
  legacy?: ConstructorParameters<
    typeof MultiSourceExternalSubtitleService
  >[0]["legacy"],
) {
  return new MultiSourceExternalSubtitleService({
    providers: new AdapterRegistry("subtitle", providers),
    titleForTicket: () => ({ kind: "series", title: "Film", year: 2020 }),
    localeForProfile: () => "en",
    isEnabled: async () => true,
    ...(legacy ? { legacy } : {}),
  });
}

describe("multi-source subtitle discovery", () => {
  it("keeps sibling subtitles, isolates a failed provider and rejects the wrong episode", async () => {
    const { record } = ticket();
    const sibling = {
      fileId: "webshare-file",
      filename: "Film.2020.S01E02.en.srt",
      extension: "srt" as const,
      language: "en",
      forced: false,
      default: false,
      matchScore: 0.97,
      matchType: "language" as const,
    };
    const legacy = {
      discover: vi.fn().mockResolvedValue([sibling]),
      load: vi.fn().mockResolvedValue({ filename: sibling.filename, content }),
    };
    const good = candidate("good", "subtitle-1");
    const goodSearch = vi.fn().mockResolvedValue([
      good,
      good,
      candidate("good", "wrong-episode", "Film.2020.S01E03"),
      {
        ...candidate("good", "stale-adapter"),
        provenance: { ...good.provenance, connectorVersion: "0.9.0" },
      },
      candidate("forged", "foreign-provider"),
    ]);
    const source = service(
      [
        subtitleProvider(
          "broken",
          vi.fn().mockRejectedValue(new Error("offline")),
        ),
        subtitleProvider("good", goodSearch),
      ],
      legacy,
    );

    const tracks = await source.discover(record);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toEqual(sibling);
    expect(tracks[1]?.fileId).toMatch(/^sub_[A-Za-z0-9_-]+$/);
    expect(tracks[1]?.filename).toBe("Film.2020.S01E02.en.srt");
    expect(goodSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Film",
        seasonNumber: 1,
        episodeNumber: 2,
        releaseName: record.sourceFilename,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expect(
      source.load(record, {
        ...tracks[1]!,
        fileId: "sub_unlisted",
      }),
    ).rejects.toThrow(/not part of the playback grant/);
    await expect(source.load(record, sibling)).resolves.toEqual({
      filename: sibling.filename,
      content,
    });
  });

  it("validates a fetched asset before serving a window through the grant", async () => {
    const { tickets, record } = ticket();
    const found = candidate("test-subtitles", "entry-1");
    const asset: SubtitleAsset = {
      ref: found.ref,
      language: found.language,
      format: found.format,
      content,
      checksumSha256: createHash("sha256").update(content).digest("hex"),
      provenance: found.provenance,
    };
    const fetch = vi.fn().mockResolvedValue(asset);
    const source = service([
      subtitleProvider(
        "test-subtitles",
        vi.fn().mockResolvedValue([found]),
        fetch,
      ),
    ]);
    const media: PlaybackMediaEngine = {
      probe: vi.fn().mockResolvedValue({
        durationSeconds: 180,
        videoCodec: "h264",
        videoPixelFormat: "yuv420p",
        audioTracks: [],
        subtitleTracks: [],
      }),
      stream: vi.fn(),
      thumbnail: vi.fn(),
      subtitle: vi.fn(),
    };
    const app = Fastify({ logger: false });
    registerPlaybackRoutes(
      app,
      tickets,
      {} as StreamerCore,
      media,
      async () => record.directUrl,
      undefined,
      source,
    );
    const base = `/api/v1/playback/grants/${record.grantId}`;
    const manifest = await app.inject({
      method: "GET",
      url: `${base}/manifest`,
    });
    expect(manifest.statusCode).toBe(200);
    const [track] = manifest.json().externalSubtitleTracks;
    expect(track.fileId).toMatch(/^sub_/);
    const unknown = await app.inject({
      method: "GET",
      url: `${base}/subtitles/external/sub_unknown/window?startMs=0`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    const window = await app.inject({
      method: "GET",
      url: `${base}/subtitles/external/${track.fileId}/window?startMs=0`,
    });
    expect(window.statusCode).toBe(200);
    expect(window.json().cues).toEqual([
      { startMs: 2000, endMs: 4000, text: "Hello" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      found.ref,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const revoked = await app.inject({ method: "DELETE", url: base });
    expect(revoked.statusCode).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: `${base}/manifest` })).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("rejects a fetched asset with a mismatched checksum", async () => {
    const { record } = ticket();
    const found = candidate("checksum", "entry-1");
    const source = service([
      subtitleProvider(
        "checksum",
        vi.fn().mockResolvedValue([found]),
        vi.fn().mockResolvedValue({
          ref: found.ref,
          language: found.language,
          format: found.format,
          content,
          checksumSha256: "0".repeat(64),
          provenance: found.provenance,
        }),
      ),
    ]);
    const [track] = await source.discover(record);
    await expect(source.load(record, track!)).rejects.toThrow(
      /mismatched asset/,
    );
  });

  it("scopes an opaque secret reference to its provider calls", async () => {
    const { record } = ticket();
    const found = candidate("vaulted", "entry-1");
    const search = vi.fn().mockResolvedValue([found]);
    const fetch = vi.fn().mockResolvedValue({
      ref: found.ref,
      language: found.language,
      format: found.format,
      content,
      checksumSha256: createHash("sha256").update(content).digest("hex"),
      provenance: found.provenance,
    });
    const source = new MultiSourceExternalSubtitleService({
      providers: new AdapterRegistry("subtitle", [
        subtitleProvider("vaulted", search, fetch),
      ]),
      titleForTicket: () => ({ kind: "series", title: "Film", year: 2020 }),
      localeForProfile: () => "en",
      isEnabled: async () => true,
      secretRefForProvider: (providerId) => `vault:${providerId}`,
    });
    const [track] = await source.discover(record);
    await source.load(record, track!);
    expect(search.mock.calls[0]?.[1]).toMatchObject({
      secretRef: "vault:vaulted",
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      secretRef: "vault:vaulted",
    });
    expect(track).not.toHaveProperty("secretRef");
  });

  it("cancels an in-flight provider search when the grant is abandoned", async () => {
    const { record } = ticket();
    const search = vi.fn<SubtitleProvider["search"]>(
      async (_request, context) =>
        await new Promise<SubtitleCandidate[]>((_resolve, reject) => {
          context.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const source = service([subtitleProvider("slow", search)]);
    const controller = new AbortController();
    const pending = source.discover(record, controller.signal);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
