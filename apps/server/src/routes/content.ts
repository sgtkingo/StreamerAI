import {
  CompleteSetupRequestSchema,
  CreateViewerProfileSchema,
  DiscoveryRequestSchema,
  EpisodeSelectionSchema,
  UpdateViewerProfileSchema,
} from "@streamer-ai/contracts";
import { ProfileLimitError } from "@streamer-ai/database";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  StreamerCore,
  DiscoverySessionClosedError,
  DiscoveryCancelledError,
  DiscoverySessionNotFoundError,
  IdempotencyConflictError,
  PlaybackNotConfiguredError,
  PlaybackRecheckError,
  PreviousRequestFailedError,
  RequestInProgressError,
  UnknownProfileError,
  UnknownTitleError,
  UnplayableTitleError,
} from "../services/streamer-core.js";

interface ContentRouteDependencies {
  core: StreamerCore;
}

const profileParamsSchema = {
  type: "object",
  required: ["profileId"],
  properties: { profileId: { type: "string", minLength: 1, maxLength: 120 } },
} as const;

const titleParamsSchema = {
  type: "object",
  required: ["profileId", "titleId"],
  properties: {
    profileId: { type: "string", minLength: 1, maxLength: 120 },
    titleId: { type: "string", minLength: 1, maxLength: 160 },
  },
} as const;

function sendDomainError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProfileLimitError) {
    return reply.code(409).send({
      error: {
        code: "PROFILE_LIMIT_REACHED",
        message: "This installation already has five profiles.",
      },
    });
  }
  if (error instanceof UnknownProfileError) {
    return reply.code(404).send({
      error: {
        code: "PROFILE_NOT_FOUND",
        message: "The requested profile does not exist.",
      },
    });
  }
  if (error instanceof UnknownTitleError) {
    return reply.code(404).send({
      error: {
        code: "TITLE_NOT_FOUND",
        message: "The title is not in the validated local cache.",
      },
    });
  }
  if (error instanceof UnplayableTitleError) {
    return reply.code(409).send({
      error: {
        code: "TITLE_NOT_PLAYABLE",
        message: "No verified playable variant is available.",
      },
    });
  }
  if (
    error instanceof DiscoverySessionNotFoundError ||
    error instanceof DiscoverySessionClosedError
  ) {
    return reply.code(404).send({
      error: {
        code: "DISCOVERY_SESSION_NOT_FOUND",
        message:
          "The discovery conversation is unavailable. Start a new search.",
      },
    });
  }
  if (error instanceof IdempotencyConflictError) {
    return reply.code(409).send({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "This request key was already used for different input.",
      },
    });
  }
  if (error instanceof RequestInProgressError) {
    return reply.code(409).send({
      error: {
        code: "REQUEST_IN_PROGRESS",
        message: "The same discovery request is still being processed.",
      },
    });
  }
  if (error instanceof PreviousRequestFailedError) {
    return reply.code(409).send({
      error: {
        code: "REQUEST_PREVIOUSLY_FAILED",
        message: "The previous attempt failed. Retry with a new request key.",
      },
    });
  }
  if (error instanceof DiscoveryCancelledError) {
    return reply.code(409).send({
      error: {
        code: "DISCOVERY_CANCELLED",
        message: "The discovery request was cancelled.",
      },
    });
  }
  if (error instanceof PlaybackNotConfiguredError) {
    return reply.code(409).send({
      error: {
        code: "PLAYBACK_NOT_CONFIGURED",
        message: "Connect and validate a live streaming provider first.",
      },
    });
  }
  if (error instanceof PlaybackRecheckError) {
    return reply.code(409).send({
      error: {
        code: "PLAYBACK_RECHECK_FAILED",
        message: "The source could not be revalidated for playback.",
      },
    });
  }
  throw error;
}

export function registerContentRoutes(
  app: FastifyInstance,
  dependencies: ContentRouteDependencies,
): void {
  app.get("/api/v1/profiles", async () => ({
    items: dependencies.core.listProfiles(),
    limit: 5,
  }));

  app.post("/api/v1/profiles", async (request, reply) => {
    const parsed = CreateViewerProfileSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Enter a valid profile name.",
        },
      });
    try {
      return reply
        .code(201)
        .send(dependencies.core.createViewerProfile(parsed.data));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.patch(
    "/api/v1/profiles/:profileId",
    { schema: { params: profileParamsSchema } },
    async (request, reply) => {
      const parsed = UpdateViewerProfileSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "Check the profile fields.",
          },
        });
      try {
        return dependencies.core.updateViewerProfile(
          (request.params as { profileId: string }).profileId,
          parsed.data,
        );
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.delete(
    "/api/v1/profiles/:profileId",
    { schema: { params: profileParamsSchema } },
    async (request, reply) => {
      try {
        dependencies.core.deleteViewerProfile(
          (request.params as { profileId: string }).profileId,
        );
        return reply.code(204).send();
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get(
    "/api/v1/home",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            profileId: { type: "string", minLength: 1, maxLength: 120 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { profileId?: string };
      try {
        return dependencies.core.home(query.profileId ?? "default");
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post(
    "/api/v1/discovery/sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["profileId", "message", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            profileId: { type: "string", minLength: 1, maxLength: 120 },
            message: { type: "string", minLength: 2, maxLength: 2_000 },
            sessionId: { type: "string", minLength: 1, maxLength: 120 },
            createSession: { type: "boolean" },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      const controller = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once("close", onClose);
      try {
        return await dependencies.core.discover(
          DiscoveryRequestSchema.parse(request.body),
          controller.signal,
        );
      } catch (error) {
        return sendDomainError(reply, error);
      } finally {
        reply.raw.off("close", onClose);
      }
    },
  );

  app.post(
    "/api/v1/discovery/fast",
    {
      schema: {
        body: {
          type: "object",
          required: ["profileId", "message", "sessionId", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            profileId: { type: "string", minLength: 1, maxLength: 120 },
            message: { type: "string", minLength: 2, maxLength: 2_000 },
            sessionId: { type: "string", minLength: 1, maxLength: 120 },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      const controller = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once("close", onClose);
      try {
        return await dependencies.core.discoverFast(
          DiscoveryRequestSchema.parse(request.body),
          controller.signal,
        );
      } catch (error) {
        return sendDomainError(reply, error);
      } finally {
        reply.raw.off("close", onClose);
      }
    },
  );

  app.post(
    "/api/v1/discovery/cancel",
    {
      schema: {
        body: {
          type: "object",
          required: ["profileId", "idempotencyKey"],
          additionalProperties: false,
          properties: {
            profileId: { type: "string", minLength: 1, maxLength: 120 },
            idempotencyKey: { type: "string", minLength: 8, maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as {
          profileId: string;
          idempotencyKey: string;
        };
        return {
          cancelled: dependencies.core.cancelDiscovery(
            body.profileId,
            body.idempotencyKey,
          ),
        };
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get(
    "/api/v1/profiles/:profileId/library",
    { schema: { params: profileParamsSchema } },
    async (request, reply) => {
      try {
        return dependencies.core.library(
          (request.params as { profileId: string }).profileId,
        );
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get(
    "/api/v1/profiles/:profileId/titles/:titleId",
    {
      schema: {
        params: titleParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { retry: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const { profileId, titleId } = request.params as {
        profileId: string;
        titleId: string;
      };
      try {
        return await dependencies.core.titleDetail(
          profileId,
          titleId,
          (request.query as { retry?: boolean }).retry === true,
        );
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post(
    "/api/v1/profiles/:profileId/titles/:titleId/force-search",
    { schema: { params: titleParamsSchema } },
    async (request, reply) => {
      const { profileId, titleId } = request.params as {
        profileId: string;
        titleId: string;
      };
      try {
        return await dependencies.core.forceTitleSearch(profileId, titleId);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post(
    "/api/v1/profiles/:profileId/titles/:titleId/episodes/force-search",
    {
      schema: {
        params: titleParamsSchema,
        body: {
          type: "object",
          required: ["seasonNumber", "episodeNumber"],
          additionalProperties: false,
          properties: {
            seasonNumber: { type: "integer", minimum: 0 },
            episodeNumber: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { profileId, titleId } = request.params as {
        profileId: string;
        titleId: string;
      };
      const episode = EpisodeSelectionSchema.safeParse(request.body);
      if (!episode.success)
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "Choose a valid episode.",
          },
        });
      try {
        return await dependencies.core.forceEpisodeSearch(
          profileId,
          titleId,
          episode.data,
        );
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.put(
    "/api/v1/profiles/:profileId/library/:titleId",
    { schema: { params: titleParamsSchema } },
    async (request, reply) => {
      const params = request.params as { profileId: string; titleId: string };
      try {
        return dependencies.core.addToLibrary(params.profileId, params.titleId);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.delete(
    "/api/v1/profiles/:profileId/library/:titleId",
    { schema: { params: titleParamsSchema } },
    async (request, reply) => {
      const params = request.params as { profileId: string; titleId: string };
      try {
        dependencies.core.removeFromLibrary(params.profileId, params.titleId);
        return reply.code(204).send();
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get(
    "/api/v1/profiles/:profileId/history",
    { schema: { params: profileParamsSchema } },
    async (request, reply) => {
      try {
        return dependencies.core.history(
          (request.params as { profileId: string }).profileId,
        );
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.delete(
    "/api/v1/profiles/:profileId/history/:eventId",
    {
      schema: {
        params: {
          type: "object",
          required: ["profileId", "eventId"],
          additionalProperties: false,
          properties: {
            profileId: { type: "string", minLength: 1, maxLength: 120 },
            eventId: { type: "string", minLength: 1, maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      const { profileId, eventId } = request.params as {
        profileId: string;
        eventId: string;
      };
      try {
        const removed = dependencies.core.removeHistoryEvent(
          profileId,
          eventId,
        );
        return removed
          ? reply.code(204).send()
          : reply.code(404).send({
              error: {
                code: "HISTORY_EVENT_NOT_FOUND",
                message: "The history event does not exist.",
              },
            });
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post(
    "/api/v1/profiles/:profileId/history/clear",
    {
      schema: {
        params: profileParamsSchema,
        body: {
          type: "object",
          required: ["confirmationToken"],
          additionalProperties: false,
          properties: {
            confirmationToken: { type: "string", const: "clear-history" },
          },
        },
      },
    },
    async (request, reply) => {
      const { profileId } = request.params as { profileId: string };
      try {
        const removedCount = dependencies.core.clearHistory(profileId);
        return { ok: true, removedCount };
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post(
    "/api/v1/profiles/:profileId/playback/check",
    {
      schema: {
        params: profileParamsSchema,
        body: {
          type: "object",
          required: ["titleId"],
          additionalProperties: false,
          properties: {
            titleId: { type: "string", minLength: 1, maxLength: 160 },
            sourceId: { type: "string", pattern: "^[a-f0-9]{32}$" },
            seasonNumber: { type: "integer", minimum: 0 },
            episodeNumber: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { profileId } = request.params as { profileId: string };
      const { titleId, sourceId, ...selection } = request.body as {
        titleId: string;
        sourceId?: string;
        seasonNumber?: number;
        episodeNumber?: number;
      };
      const episode =
        Object.keys(selection).length === 0
          ? undefined
          : EpisodeSelectionSchema.safeParse(selection).data;
      if (Object.keys(selection).length > 0 && !episode)
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "Choose a valid episode.",
          },
        });
      try {
        const languages = await dependencies.core.checkPlayback(
          profileId,
          titleId,
          episode,
          sourceId,
        );
        return { ok: true, ...(languages ?? {}) };
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post(
    "/api/v1/profiles/:profileId/playback/prepare",
    {
      schema: {
        params: profileParamsSchema,
        body: {
          type: "object",
          required: ["titleId"],
          additionalProperties: false,
          properties: {
            titleId: { type: "string", minLength: 1, maxLength: 160 },
            sourceId: { type: "string", pattern: "^[a-f0-9]{32}$" },
            seasonNumber: { type: "integer", minimum: 0 },
            episodeNumber: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { profileId } = request.params as { profileId: string };
      const { titleId, sourceId, ...selection } = request.body as {
        titleId: string;
        sourceId?: string;
        seasonNumber?: number;
        episodeNumber?: number;
      };
      const episode =
        Object.keys(selection).length === 0
          ? undefined
          : EpisodeSelectionSchema.safeParse(selection).data;
      if (Object.keys(selection).length > 0 && !episode)
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "Choose a valid episode.",
          },
        });
      try {
        return {
          ok: true,
          playback: await dependencies.core.preparePlayback(
            profileId,
            titleId,
            episode,
            sourceId,
          ),
        };
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post(
    "/api/v1/profiles/:profileId/playback/start",
    {
      schema: {
        params: profileParamsSchema,
        body: {
          type: "object",
          required: ["titleId"],
          additionalProperties: false,
          properties: {
            titleId: { type: "string", minLength: 1, maxLength: 160 },
          },
        },
      },
    },
    async (request, reply) => {
      const { profileId } = request.params as { profileId: string };
      const { titleId } = request.body as { titleId: string };
      try {
        const result = await dependencies.core.startPlayback(
          profileId,
          titleId,
        );
        return {
          ok: true,
          eventId: result.eventId,
          library: result.library,
          playback: result.playback,
        };
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post("/api/v1/setup/complete", async (request, reply) => {
    const parsed = CompleteSetupRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The setup profile is incomplete.",
        },
      });
    }
    const profileId = parsed.data.profileId ?? "default";
    try {
      if (profileId !== "default") dependencies.core.requireProfile(profileId);
      dependencies.core.configureProfile({
        id: profileId,
        ...parsed.data.profile,
        localAiEnabled: parsed.data.localAiEnabled,
      });
    } catch (error) {
      return sendDomainError(reply, error);
    }
    return reply.code(204).send();
  });
}
