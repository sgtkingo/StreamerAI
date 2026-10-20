import { randomUUID } from "node:crypto";

export const STREAMER_TOOLS = [
  {
    name: "search_media",
    description:
      "Search films and series using the active StreamerAI discovery rules and verified providers.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 2, maxLength: 2000 },
        profileId: { type: "string", maxLength: 120 },
      },
    },
  },
  {
    name: "inspect_media",
    description:
      "Inspect a validated title and its availability without source URLs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["titleId"],
      properties: {
        titleId: { type: "string", maxLength: 160 },
        profileId: { type: "string", maxLength: 120 },
      },
    },
  },
  {
    name: "get_subtitles",
    description: "List subtitle tracks for an active opaque playback grant.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["grantId"],
      properties: { grantId: { type: "string", maxLength: 160 } },
    },
  },
  {
    name: "start_playback",
    description:
      "Create an opaque playback grant for a verified title. The user opens playback in StreamerAI.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["titleId"],
      properties: {
        titleId: { type: "string", maxLength: 160 },
        profileId: { type: "string", maxLength: 120 },
      },
    },
  },
  {
    name: "stop_playback",
    description: "Revoke an active playback grant.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["grantId"],
      properties: { grantId: { type: "string", maxLength: 160 } },
    },
  },
] as const;

type Json = Record<string, unknown>;
function record(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}
function safeId(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(value))
    throw new Error("Invalid identifier.");
  return value;
}
function safeTitle(value: unknown): Json {
  const title = record(value);
  return {
    id: title.id,
    title: title.title,
    originalTitle: title.originalTitle,
    kind: title.kind,
    year: title.year,
    synopsis: title.synopsis,
    genres: title.genres,
    availability: title.availability,
    matchPercent: title.matchPercent,
    seriesCoverage: title.seriesCoverage,
  };
}

/** The only path from MCP or embedded agents into StreamerAI business routes. */
export class StreamerToolService {
  private readonly issuedGrantIds = new Set<string>();
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly boundProfileId?: string,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "MCP backend must be a local HTTP address without credentials.",
      );
    if (boundProfileId !== undefined) safeId(boundProfileId);
  }
  private profileId(value: unknown): string {
    const profileId = safeId(value, this.boundProfileId ?? "default");
    if (this.boundProfileId && profileId !== this.boundProfileId)
      throw new Error("This MCP bridge is bound to another profile.");
    return profileId;
  }
  private grantId(value: unknown): string {
    const grantId = safeId(value);
    if (this.boundProfileId && !this.issuedGrantIds.has(grantId))
      throw new Error("This MCP bridge did not create this playback grant.");
    return grantId;
  }
  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Json,
    signal?: AbortSignal,
  ): Promise<Json> {
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(120_000),
      ]),
    });
    if (!response.ok) {
      const error = record(await response.json().catch(() => ({}))).error;
      throw new Error(
        String(
          record(error).message ??
            `StreamerAI request failed (${response.status}).`,
        ),
      );
    }
    if (response.status === 204) return { ok: true };
    return record(await response.json());
  }
  async call(name: string, args: Json, signal?: AbortSignal): Promise<Json> {
    if (name === "search_media") {
      if (
        typeof args.query !== "string" ||
        args.query.trim().length < 2 ||
        args.query.length > 2000
      )
        throw new Error("Invalid query.");
      const profileId = this.profileId(args.profileId);
      const data = await this.request(
        "POST",
        "/api/v1/discovery/sessions",
        { profileId, message: args.query, idempotencyKey: randomUUID() },
        signal,
      );
      const ranked = (item: unknown) => {
        const value = record(item);
        return { title: safeTitle(value.title), reason: value.reason };
      };
      return {
        sessionId: data.sessionId,
        stage: data.stage,
        reply: data.reply,
        bestMatch: data.bestMatch ? ranked(data.bestMatch) : null,
        available: Array.isArray(data.available)
          ? data.available.map(ranked)
          : [],
        unavailable: Array.isArray(data.unavailable)
          ? data.unavailable.map(ranked)
          : [],
        unverified: Array.isArray(data.unverified)
          ? data.unverified.map(ranked)
          : [],
        warnings: data.warnings,
      };
    }
    if (name === "inspect_media") {
      const profileId = this.profileId(args.profileId);
      const titleId = safeId(args.titleId);
      const data = await this.request(
        "GET",
        `/api/v1/profiles/${encodeURIComponent(profileId)}/titles/${encodeURIComponent(titleId)}`,
        undefined,
        signal,
      );
      const series = record(data.series);
      return {
        title: safeTitle(data.title),
        series: data.series
          ? {
              seasons: Array.isArray(series.seasons)
                ? series.seasons.map((season) => {
                    const item = record(season);
                    return {
                      seasonNumber: item.seasonNumber,
                      title: item.title,
                      episodeCount: Array.isArray(item.episodes)
                        ? item.episodes.length
                        : 0,
                    };
                  })
                : [],
            }
          : null,
      };
    }
    if (name === "get_subtitles") {
      const grantId = this.grantId(args.grantId);
      const data = await this.request(
        "GET",
        `/api/v1/playback/grants/${encodeURIComponent(grantId)}/manifest`,
        undefined,
        signal,
      );
      const tracks = [
        ...(Array.isArray(data.subtitleTracks) ? data.subtitleTracks : []),
        ...(Array.isArray(data.externalSubtitleTracks)
          ? data.externalSubtitleTracks
          : []),
      ];
      return {
        grantId,
        tracks: tracks.map((item) => {
          const track = record(item);
          return {
            language: track.language,
            title: track.title,
            format: track.format,
            source: track.source,
            forced: track.forced,
            hearingImpaired: track.hearingImpaired,
          };
        }),
      };
    }
    if (name === "start_playback") {
      const profileId = this.profileId(args.profileId);
      const titleId = safeId(args.titleId);
      const data = await this.request(
        "POST",
        `/api/v1/profiles/${encodeURIComponent(profileId)}/playback/start`,
        { titleId },
        signal,
      );
      const playback = record(data.playback);
      const grantId = safeId(playback.grantId);
      this.issuedGrantIds.add(grantId);
      return {
        ok: true,
        titleId,
        grantId,
        expiresAt: playback.expiresAt,
        message:
          "Playback grant created. Open the title in StreamerAI to play it.",
      };
    }
    if (name === "stop_playback") {
      const grantId = this.grantId(args.grantId);
      await this.request(
        "DELETE",
        `/api/v1/playback/grants/${encodeURIComponent(grantId)}`,
        undefined,
        signal,
      );
      this.issuedGrantIds.delete(grantId);
      return { ok: true, grantId };
    }
    throw new Error("Unknown StreamerAI tool.");
  }
}
