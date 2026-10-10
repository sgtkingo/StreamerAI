import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import type { ExternalSubtitleTrack } from "@streamer-ai/contracts";
import { PlaybackMediaError } from "../services/playback-media-engine.js";
import {
  SubtitleService,
  SubtitleServiceError,
} from "../services/subtitle-service.js";
import type {
  PlaybackMediaEngine,
  PlaybackMediaInfo,
} from "../services/playback-media-engine.js";
import type {
  PlaybackTicketRecord,
  PlaybackTicketStore,
} from "../services/playback-ticket-store.js";
import { validatePlaybackSourceUrl } from "../services/playback-ticket-store.js";
import type { StreamerCore } from "../services/streamer-core.js";
import type { MultiSourceExternalSubtitleService } from "../services/multi-source-subtitle-service.js";

export interface ExternalSubtitleSource {
  discover(
    mediaFileId: string,
    mediaFilename?: string,
    signal?: AbortSignal,
  ): Promise<ExternalSubtitleTrack[]>;
  load(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<{ filename: string; content: string }>;
}

function safeFailure(error: unknown) {
  return error instanceof PlaybackMediaError
    ? { failureCode: error.failureCode, exitCode: error.exitCode }
    : { failureCode: "UNEXPECTED_MEDIA_FAILURE" };
}

export function registerPlaybackRoutes(
  app: FastifyInstance,
  ticketStore: PlaybackTicketStore,
  core: StreamerCore,
  mediaEngine: PlaybackMediaEngine,
  refreshSource: (ticket: PlaybackTicketRecord) => Promise<string>,
  externalSubtitleSource?: ExternalSubtitleSource,
  multiSourceSubtitles?: MultiSourceExternalSubtitleService,
): void {
  const mediaInfo = new Map<string, Promise<PlaybackMediaInfo>>();
  const thumbnails = new Map<string, Buffer>();
  const thumbnailJobs = new Map<string, Promise<Buffer>>();
  const subtitleService = new SubtitleService();
  const externalTracks = new Map<string, Promise<ExternalSubtitleTrack[]>>();
  const externalAbort = new Map<string, AbortController>();
  let activeMedia: { grantId: string; stop: () => void } | null = null;
  const sources = new Map<string, { url: string; validUntil: number }>();
  const sourceFor = async (
    ticket: PlaybackTicketRecord,
    forceRefresh = false,
  ) => {
    const cached = sources.get(ticket.grantId);
    if (!forceRefresh && cached && cached.validUntil > Date.now())
      return cached.url;
    const url = validatePlaybackSourceUrl(
      cached !== undefined || forceRefresh
        ? await refreshSource(ticket)
        : ticket.directUrl,
      ticket.providerId,
    );
    const engineSource =
      ticket.providerId === "local-files" && url.startsWith("file:")
        ? fileURLToPath(url)
        : url;
    sources.clear();
    // Third-party adapters may issue URLs with very short lifetimes. Their
    // refresh method is called on each subsequent media request.
    sources.set(ticket.grantId, {
      url: engineSource,
      validUntil: ticket.providerId === "webshare" ? Date.now() + 60_000 : 0,
    });
    return engineSource;
  };
  app.addHook("onClose", async () => {
    activeMedia?.stop();
    for (const controller of externalAbort.values()) controller.abort();
    subtitleService.close();
  });
  const externalFor = (ticket: PlaybackTicketRecord) => {
    if (
      !multiSourceSubtitles &&
      (ticket.providerId !== "webshare" ||
        !ticket.sourceFilename ||
        !externalSubtitleSource)
    )
      return Promise.resolve([]);
    const cached = externalTracks.get(ticket.grantId);
    if (cached) return cached;
    for (const controller of externalAbort.values()) controller.abort();
    externalAbort.clear();
    externalTracks.clear();
    const controller = new AbortController();
    const job = (
      multiSourceSubtitles
        ? multiSourceSubtitles.discover(ticket, controller.signal)
        : externalSubtitleSource!.discover(
            ticket.variantId,
            ticket.sourceFilename!,
          )
    ).catch(() => {
      externalTracks.delete(ticket.grantId);
      externalAbort.delete(ticket.grantId);
      app.log.warn(
        { code: "PLAYBACK_EXTERNAL_SUBTITLE_DISCOVERY_FAILED" },
        "External subtitle discovery unavailable",
      );
      return [] as ExternalSubtitleTrack[];
    });
    externalAbort.set(ticket.grantId, controller);
    externalTracks.set(ticket.grantId, job);
    return job;
  };
  const subtitleMediaIdentity = (ticket: PlaybackTicketRecord) =>
    `${ticket.providerId}:${ticket.variantId}:${ticket.sourceSizeBytes ?? "unknown"}:${ticket.grantId}`;
  const infoFor = (grantId: string, sourceUrl: string) => {
    const cached = mediaInfo.get(grantId);
    if (cached) return cached;
    mediaInfo.clear();
    const promise = mediaEngine.probe(sourceUrl).catch((error: unknown) => {
      mediaInfo.delete(grantId);
      throw error;
    });
    mediaInfo.set(grantId, promise);
    return promise;
  };
  const errorResponse = {
    error: {
      code: "PLAYBACK_MEDIA_UNAVAILABLE",
      message: "The video could not be prepared for playback.",
    },
  };
  const expiredResponse = {
    error: {
      code: "PLAYBACK_GRANT_EXPIRED",
      message: "The playback grant is missing or expired.",
    },
  };
  const paramsSchema = {
    type: "object",
    required: ["grantId"],
    additionalProperties: false,
    properties: {
      grantId: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        pattern: "^[A-Za-z0-9_-]+$",
      },
    },
  } as const;

  app.get(
    "/api/v1/playback/grants/:grantId/manifest",
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      const ticket = ticketStore.get(grantId);
      if (!ticket) return reply.code(404).send(expiredResponse);
      let phase = "source";
      try {
        const discovery = externalFor(ticket);
        const sourceUrl = await sourceFor(ticket);
        phase = "probe";
        const info = await infoFor(grantId, sourceUrl);
        const discovered = await discovery;
        const manifest: PlaybackMediaInfo = {
          ...info,
          seekable: ticket.supportsHttpRange ?? null,
          sourceSizeBytes: ticket.sourceSizeBytes ?? null,
          sourceVersion:
            ticket.providerId === "webshare" ? ticket.variantId : null,
          externalSubtitleTracks: discovered,
        };
        request.log.info(
          {
            code: "PLAYBACK_MANIFEST_READY",
            audioTrackCount: info.audioTracks.length,
            subtitleTrackCount: info.subtitleTracks.length,
            externalSubtitleTrackCount: discovered.length,
          },
          "Playback media inspected",
        );
        return reply
          .header("cache-control", "no-store, private")
          .send(manifest);
      } catch (error) {
        request.log.error(
          { code: "PLAYBACK_MANIFEST_FAILED", phase, ...safeFailure(error) },
          "Playback media inspection failed",
        );
        return reply.code(502).send(errorResponse);
      }
    },
  );

  app.post(
    "/api/v1/playback/grants/:grantId/progress",
    {
      schema: {
        params: paramsSchema,
        body: {
          type: "object",
          required: ["progressPercent"],
          additionalProperties: false,
          properties: {
            progressPercent: { type: "number", minimum: 0, maximum: 100 },
            positionSeconds: { type: "number", minimum: 0 },
            durationSeconds: { type: "number", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      const ticket = ticketStore.get(grantId);
      if (!ticket) return reply.code(404).send(expiredResponse);
      const {
        progressPercent,
        positionSeconds = 0,
        durationSeconds = 0,
      } = request.body as {
        progressPercent: number;
        positionSeconds?: number;
        durationSeconds?: number;
      };
      if (!ticket.started && progressPercent !== 0)
        return reply.code(409).send(errorResponse);
      core.recordPlaybackProgress(
        ticket.profileId,
        ticket.titleId,
        progressPercent,
        positionSeconds,
        durationSeconds,
        typeof ticket.seasonNumber === "number" &&
          typeof ticket.episodeNumber === "number"
          ? {
              seasonNumber: ticket.seasonNumber,
              episodeNumber: ticket.episodeNumber,
            }
          : undefined,
      );
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/v1/playback/grants/:grantId/media",
    {
      schema: {
        params: paramsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            audio: { type: "string", pattern: "^[0-9]{1,3}$" },
            start: {
              type: "string",
              pattern: "^[0-9]{1,5}(?:\\.[0-9]{1,3})?$",
            },
            refresh: { type: "string", pattern: "^1$" },
          },
        },
      },
    },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      const ticket = ticketStore.get(grantId);
      if (!ticket) return reply.code(404).send(expiredResponse);
      const query = request.query as {
        audio?: string;
        start?: string;
        refresh?: string;
      };
      const start = Number(query.start ?? "0");
      if (!Number.isFinite(start) || start < 0 || start > 86_400) {
        return reply.code(400).send(errorResponse);
      }
      let phase = "source";
      try {
        const sourceUrl = await sourceFor(ticket, query.refresh === "1");
        phase = "probe";
        const info = await infoFor(grantId, sourceUrl);
        if (info.durationSeconds !== null && start >= info.durationSeconds) {
          return reply.code(400).send(errorResponse);
        }
        const audio =
          query.audio === undefined
            ? (info.audioTracks[0]?.streamIndex ?? null)
            : Number(query.audio);
        if (
          audio !== null &&
          !info.audioTracks.some((track) => track.streamIndex === audio)
        ) {
          return reply.code(400).send(errorResponse);
        }
        phase = "stream";
        activeMedia?.stop();
        const media = mediaEngine.stream(sourceUrl, info, audio, start);
        activeMedia = { grantId, stop: media.stop };
        request.log.info(
          {
            code: "PLAYBACK_STREAM_STARTED",
            audioTrackSelected: audio !== null,
            resumed: start > 0,
            sourceRefreshed: query.refresh === "1",
          },
          "Playback media stream started",
        );
        void media.completion
          ?.then((outcome) => {
            const details = {
              code:
                outcome.status === "failed"
                  ? "PLAYBACK_STREAM_FAILED"
                  : "PLAYBACK_STREAM_FINISHED",
              status: outcome.status,
              exitCode: outcome.exitCode,
              bytes: outcome.bytes,
              timedOut: outcome.timedOut ?? false,
            };
            if (outcome.status === "failed") {
              request.log.error(details, "Playback media stream failed");
            } else {
              request.log.info(details, "Playback media stream finished");
            }
          })
          .catch(() => {
            request.log.warn(
              { code: "PLAYBACK_STREAM_MONITOR_FAILED" },
              "Playback stream status unavailable",
            );
          });
        reply.raw.on("close", () => {
          media.stop();
          if (activeMedia?.stop === media.stop) activeMedia = null;
        });
        if (ticketStore.markStarted(grantId)) {
          core.recordPlaybackStart(
            ticket.profileId,
            ticket.titleId,
            typeof ticket.seasonNumber === "number" &&
              typeof ticket.episodeNumber === "number"
              ? {
                  seasonNumber: ticket.seasonNumber,
                  episodeNumber: ticket.episodeNumber,
                }
              : undefined,
            {
              providerId: ticket.providerId,
              candidateId: ticket.candidateId ?? ticket.variantId,
            },
          );
        }
        return reply
          .header("content-type", "video/mp4")
          .header("cache-control", "no-store, private")
          .header("accept-ranges", "none")
          .header("x-content-type-options", "nosniff")
          .send(media.body);
      } catch (error) {
        request.log.error(
          {
            code: "PLAYBACK_STREAM_SETUP_FAILED",
            phase,
            ...safeFailure(error),
          },
          "Playback stream could not be started",
        );
        return reply.code(502).send(errorResponse);
      }
    },
  );

  app.get(
    "/api/v1/playback/grants/:grantId/thumbnail",
    {
      schema: {
        params: paramsSchema,
        querystring: {
          type: "object",
          required: ["at"],
          additionalProperties: false,
          properties: { at: { type: "string", pattern: "^[0-9]{1,5}$" } },
        },
      },
    },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      const ticket = ticketStore.get(grantId);
      if (!ticket) return reply.code(404).send(expiredResponse);
      const at = Number((request.query as { at: string }).at);
      if (at > 86_400) return reply.code(400).send(errorResponse);
      let phase = "source";
      try {
        const sourceUrl = await sourceFor(ticket);
        phase = "probe";
        const info = await infoFor(grantId, sourceUrl);
        const position =
          Math.floor(
            Math.min(at, Math.max(0, (info.durationSeconds ?? at) - 0.1)) / 5,
          ) * 5;
        const key = `${grantId}:${position}`;
        let image = thumbnails.get(key);
        if (!image) {
          let job = thumbnailJobs.get(key);
          if (!job) {
            if (thumbnailJobs.size > 0) {
              return reply.code(429).send({
                error: {
                  code: "PLAYBACK_THUMBNAIL_BUSY",
                  message: "A preview image is being prepared.",
                },
              });
            }
            phase = "thumbnail";
            job = mediaEngine.thumbnail(sourceUrl, position).finally(() => {
              thumbnailJobs.delete(key);
            });
            thumbnailJobs.set(key, job);
          }
          image = await job;
          if (image.length === 0) throw new Error("Empty thumbnail.");
          if (thumbnails.size >= 24)
            thumbnails.delete(thumbnails.keys().next().value!);
          thumbnails.set(key, image);
        }
        return reply
          .header("content-type", "image/jpeg")
          .header("cache-control", "no-store, private")
          .send(image);
      } catch (error) {
        request.log.warn(
          { code: "PLAYBACK_THUMBNAIL_FAILED", phase, ...safeFailure(error) },
          "Playback preview image unavailable",
        );
        return reply.code(502).send(errorResponse);
      }
    },
  );

  const subtitleQuerySchema = {
    type: "object",
    required: ["startMs"],
    additionalProperties: false,
    properties: {
      startMs: { type: "string", pattern: "^[0-9]{1,8}$" },
      durationMs: { type: "string", pattern: "^[0-9]{1,6}$" },
    },
  } as const;
  const subtitleFailureResponse = (code: string, message: string) => ({
    error: { code, message },
  });
  const subtitleFailure = (
    error: unknown,
    request: { log: typeof app.log },
    phase: string,
  ) => {
    if (
      error instanceof PlaybackMediaError &&
      error.failureCode === "PROCESS_CANCELLED"
    ) {
      return {
        status: 499,
        body: subtitleFailureResponse(
          "SUBTITLE_CANCELLED",
          "Subtitle request cancelled.",
        ),
      };
    }
    const status =
      error instanceof SubtitleServiceError ? error.statusCode : 502;
    request.log.warn(
      { code: "PLAYBACK_SUBTITLE_WINDOW_FAILED", phase, ...safeFailure(error) },
      "Playback subtitle window unavailable",
    );
    return {
      status,
      body: subtitleFailureResponse(
        status === 400
          ? "SUBTITLE_WINDOW_INVALID"
          : status === 429
            ? "SUBTITLE_BUSY"
            : "SUBTITLE_UNAVAILABLE",
        status === 429
          ? "Subtitle processing is busy. Try again shortly."
          : "The selected subtitle window is unavailable.",
      ),
    };
  };

  app.get(
    "/api/v1/playback/grants/:grantId/subtitles/:streamIndex/window",
    {
      schema: {
        params: {
          type: "object",
          required: ["grantId", "streamIndex"],
          additionalProperties: false,
          properties: {
            grantId: paramsSchema.properties.grantId,
            streamIndex: { type: "string", pattern: "^[0-9]{1,3}$" },
          },
        },
        querystring: subtitleQuerySchema,
      },
    },
    async (request, reply) => {
      const { grantId, streamIndex } = request.params as {
        grantId: string;
        streamIndex: string;
      };
      const ticket = ticketStore.get(grantId);
      if (!ticket) return reply.code(404).send(expiredResponse);
      const { startMs, durationMs } = request.query as {
        startMs: string;
        durationMs?: string;
      };
      const controller = new AbortController();
      const onClose = () => controller.abort();
      reply.raw.on("close", onClose);
      let phase = "source";
      const startedAt = Date.now();
      const cacheHitsBefore = subtitleService.stats.cacheHits;
      try {
        const sourceUrl = await sourceFor(ticket);
        phase = "probe";
        const info = await infoFor(grantId, sourceUrl);
        const index = Number(streamIndex);
        const track = info.subtitleTracks.find(
          (item) => item.streamIndex === index,
        );
        if (!track) {
          return reply.code(404).send(errorResponse);
        }
        if (ticket.supportsHttpRange === false) {
          return reply
            .code(409)
            .send(
              subtitleFailureResponse(
                "SUBTITLE_SOURCE_NOT_SEEKABLE",
                "This source does not support subtitle seeking.",
              ),
            );
        }
        phase = "extract";
        const result = await subtitleService.getEmbeddedWindow({
          mediaIdentity: subtitleMediaIdentity(ticket),
          trackId: `embedded:${index}`,
          sourceUrl,
          streamIndex: index,
          startMs: Number(startMs),
          ...(durationMs ? { durationMs: Number(durationMs) } : {}),
          movieDurationMs:
            info.durationSeconds === null ? null : info.durationSeconds * 1000,
          extract: (url, stream, seek, length, signal, maxCues) =>
            maxCues === undefined
              ? mediaEngine.subtitle(url, stream, seek, length, signal)
              : mediaEngine.subtitle(
                  url,
                  stream,
                  seek,
                  length,
                  signal,
                  maxCues,
                ),
          ...(track.codec === "subrip" &&
          /matroska|webm/.test(info.container ?? "") &&
          mediaEngine.subtitlePacketCount
            ? {
                scanPackets: (
                  url: string,
                  stream: number,
                  seek: number,
                  end: number,
                  signal: AbortSignal,
                ) =>
                  mediaEngine.subtitlePacketCount!(
                    url,
                    stream,
                    seek,
                    end,
                    signal,
                  ),
              }
            : {}),
          signal: controller.signal,
        });
        request.log.info(
          {
            code: "PLAYBACK_SUBTITLE_WINDOW_READY",
            source: "embedded",
            durationMs: Date.now() - startedAt,
            cueCount: result.cues.length,
            cacheHit: subtitleService.stats.cacheHits > cacheHitsBefore,
            cacheBytes: subtitleService.stats.cachedBytes,
          },
          "Playback subtitle window ready",
        );
        return reply.header("cache-control", "no-store, private").send(result);
      } catch (error) {
        const failure = subtitleFailure(error, request, phase);
        return reply.code(failure.status).send(failure.body);
      } finally {
        reply.raw.off("close", onClose);
      }
    },
  );

  app.get(
    "/api/v1/playback/grants/:grantId/subtitles/external/:fileId/window",
    {
      schema: {
        params: {
          type: "object",
          required: ["grantId", "fileId"],
          additionalProperties: false,
          properties: {
            grantId: paramsSchema.properties.grantId,
            fileId: {
              type: "string",
              minLength: 1,
              maxLength: 240,
              pattern: "^[A-Za-z0-9_-]+$",
            },
          },
        },
        querystring: subtitleQuerySchema,
      },
    },
    async (request, reply) => {
      const { grantId, fileId } = request.params as {
        grantId: string;
        fileId: string;
      };
      const ticket = ticketStore.get(grantId);
      if (!ticket || (!externalSubtitleSource && !multiSourceSubtitles))
        return reply.code(404).send(expiredResponse);
      const { startMs, durationMs } = request.query as {
        startMs: string;
        durationMs?: string;
      };
      const controller = new AbortController();
      const onClose = () => controller.abort();
      reply.raw.on("close", onClose);
      let phase = "discovery";
      const startedAt = Date.now();
      const cacheHitsBefore = subtitleService.stats.cacheHits;
      try {
        const candidates = await externalFor(ticket);
        const candidate = candidates.find((item) => item.fileId === fileId);
        if (!candidate) {
          return reply.code(404).send(errorResponse);
        }
        phase = "probe";
        const sourceUrl = await sourceFor(ticket);
        const info = await infoFor(grantId, sourceUrl);
        phase = "download";
        const result = await subtitleService.getExternalWindow({
          mediaIdentity: subtitleMediaIdentity(ticket),
          trackId: `external:${fileId}`,
          fileId,
          startMs: Number(startMs),
          ...(durationMs ? { durationMs: Number(durationMs) } : {}),
          movieDurationMs:
            info.durationSeconds === null ? null : info.durationSeconds * 1000,
          load: async (signal) => {
            const loaded = multiSourceSubtitles
              ? await multiSourceSubtitles.load(ticket, candidate, signal)
              : await externalSubtitleSource!.load(fileId, signal);
            if (loaded.filename !== candidate.filename) {
              throw new SubtitleServiceError("INVALID_SUBTITLE", 502);
            }
            return loaded;
          },
          signal: controller.signal,
        });
        request.log.info(
          {
            code: "PLAYBACK_SUBTITLE_WINDOW_READY",
            source: "external",
            durationMs: Date.now() - startedAt,
            cueCount: result.cues.length,
            cacheHit: subtitleService.stats.cacheHits > cacheHitsBefore,
            cacheBytes: subtitleService.stats.cachedBytes,
          },
          "Playback subtitle window ready",
        );
        return reply.header("cache-control", "no-store, private").send(result);
      } catch (error) {
        const failure = subtitleFailure(error, request, phase);
        return reply.code(failure.status).send(failure.body);
      } finally {
        reply.raw.off("close", onClose);
      }
    },
  );

  app.delete(
    "/api/v1/playback/grants/:grantId",
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      const ticket = ticketStore.get(grantId);
      if (activeMedia?.grantId === grantId) {
        activeMedia.stop();
        activeMedia = null;
      }
      ticketStore.revoke(grantId);
      if (ticket) subtitleService.cancelMedia(subtitleMediaIdentity(ticket));
      sources.delete(grantId);
      mediaInfo.delete(grantId);
      externalAbort.get(grantId)?.abort();
      externalAbort.delete(grantId);
      externalTracks.delete(grantId);
      multiSourceSubtitles?.forget(grantId);
      for (const key of thumbnails.keys()) {
        if (key.startsWith(`${grantId}:`)) thumbnails.delete(key);
      }
      return reply.code(204).send();
    },
  );
}
