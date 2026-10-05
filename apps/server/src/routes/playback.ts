import type { FastifyInstance } from "fastify";
import {
  SUBTITLE_WINDOW_OVERLAP_SECONDS,
  subtitleWindowStart,
} from "@streamer-ai/contracts";
import { PlaybackMediaError } from "../services/playback-media-engine.js";
import type {
  PlaybackMediaEngine,
  PlaybackMediaInfo,
} from "../services/playback-media-engine.js";
import type {
  PlaybackTicketRecord,
  PlaybackTicketStore,
} from "../services/playback-ticket-store.js";
import type { StreamerCore } from "../services/streamer-core.js";

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
): void {
  const mediaInfo = new Map<string, Promise<PlaybackMediaInfo>>();
  const thumbnails = new Map<string, Buffer>();
  const thumbnailJobs = new Map<string, Promise<Buffer>>();
  const subtitles = new Map<string, Buffer>();
  let activeMedia: { grantId: string; stop: () => void } | null = null;
  const sources = new Map<string, { url: string; validUntil: number }>();
  const sourceFor = async (ticket: PlaybackTicketRecord) => {
    const cached = sources.get(ticket.grantId);
    if (cached && cached.validUntil > Date.now()) return cached.url;
    const url = cached ? await refreshSource(ticket) : ticket.directUrl;
    sources.clear();
    sources.set(ticket.grantId, { url, validUntil: Date.now() + 60_000 });
    return url;
  };
  app.addHook("onClose", async () => {
    activeMedia?.stop();
  });
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
    "/api/v1/playback/grants/:grantId",
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      const ticket = ticketStore.get(grantId);
      if (ticket === null) {
        return reply.code(404).send(expiredResponse);
      }
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
        );
      }
      return reply
        .header("cache-control", "no-store, private")
        .header("referrer-policy", "no-referrer")
        .redirect(ticket.directUrl, 302);
    },
  );

  app.get(
    "/api/v1/playback/grants/:grantId/manifest",
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      const ticket = ticketStore.get(grantId);
      if (!ticket) return reply.code(404).send(expiredResponse);
      let phase = "source";
      try {
        const sourceUrl = await sourceFor(ticket);
        phase = "probe";
        const info = await infoFor(grantId, sourceUrl);
        request.log.info(
          {
            code: "PLAYBACK_MANIFEST_READY",
            audioTrackCount: info.audioTracks.length,
            subtitleTrackCount: info.subtitleTracks.length,
          },
          "Playback media inspected",
        );
        return reply.header("cache-control", "no-store, private").send(info);
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
          },
        },
      },
    },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      const ticket = ticketStore.get(grantId);
      if (!ticket) return reply.code(404).send(expiredResponse);
      const query = request.query as { audio?: string; start?: string };
      const start = Number(query.start ?? "0");
      if (!Number.isFinite(start) || start < 0 || start > 86_400) {
        return reply.code(400).send(errorResponse);
      }
      let phase = "source";
      try {
        const sourceUrl = await sourceFor(ticket);
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

  app.get(
    "/api/v1/playback/grants/:grantId/subtitles/:streamIndex",
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
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            at: { type: "string", pattern: "^[0-9]{1,5}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const { grantId, streamIndex } = request.params as {
        grantId: string;
        streamIndex: string;
      };
      const { at = "0" } = request.query as { at?: string };
      const requestedAt = Number(at);
      if (requestedAt > 86_400) return reply.code(400).send(errorResponse);
      const windowStart = subtitleWindowStart(requestedAt);
      const ticket = ticketStore.get(grantId);
      if (!ticket) return reply.code(404).send(expiredResponse);
      let phase = "source";
      try {
        const sourceUrl = await sourceFor(ticket);
        phase = "probe";
        const info = await infoFor(grantId, sourceUrl);
        const index = Number(streamIndex);
        if (!info.subtitleTracks.some((track) => track.streamIndex === index)) {
          return reply.code(404).send(errorResponse);
        }
        const key = `${grantId}:${index}:${windowStart}`;
        let body = subtitles.get(key);
        if (!body) {
          phase = "subtitle";
          body = await mediaEngine.subtitle(sourceUrl, index, windowStart);
          if (subtitles.size >= 12)
            subtitles.delete(subtitles.keys().next().value!);
          subtitles.set(key, body);
        }
        return reply
          .header("content-type", "text/vtt; charset=utf-8")
          .header(
            "x-streamer-subtitle-offset",
            String(Math.max(0, windowStart - SUBTITLE_WINDOW_OVERLAP_SECONDS)),
          )
          .header("cache-control", "no-store, private")
          .send(body);
      } catch (error) {
        request.log.warn(
          { code: "PLAYBACK_SUBTITLE_FAILED", phase, ...safeFailure(error) },
          "Playback subtitle track unavailable",
        );
        return reply.code(502).send(errorResponse);
      }
    },
  );

  app.delete(
    "/api/v1/playback/grants/:grantId",
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      if (activeMedia?.grantId === grantId) {
        activeMedia.stop();
        activeMedia = null;
      }
      ticketStore.revoke(grantId);
      sources.delete(grantId);
      mediaInfo.delete(grantId);
      for (const key of thumbnails.keys()) {
        if (key.startsWith(`${grantId}:`)) thumbnails.delete(key);
      }
      for (const key of subtitles.keys()) {
        if (key.startsWith(`${grantId}:`)) subtitles.delete(key);
      }
      return reply.code(204).send();
    },
  );
}
