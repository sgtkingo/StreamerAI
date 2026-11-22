import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  MediaCandidate,
  MediaCandidateRef,
  MediaFormat,
  PlaybackGrant,
  PlaybackLanguageAvailability,
} from "@streamer-ai/contracts";
import {
  directCatalogTitle,
  directSearchItems,
  directTitleId,
} from "../services/direct-search.js";
import type { StreamerCore } from "../services/streamer-core.js";

/** The live source coordinator's Fast Search surface. */
export interface DirectSearchBackend {
  directSearchProviders(
    profileId: string,
  ): Promise<{ id: string; name: string; mediaDetails?: boolean }[]>;
  directSearch(
    profileId: string,
    providerId: string,
    query: string,
    offset: number,
    limit: number,
  ): Promise<MediaCandidate[]>;
  /** Measured formats for result rows; empty when the source has none. */
  directDetails?(
    profileId: string,
    providerId: string,
    candidateIds: readonly string[],
  ): Promise<{ candidateId: string; format: MediaFormat | null }[]>;
  directInspect(
    profileId: string,
    ref: MediaCandidateRef,
  ): Promise<{
    format: MediaFormat;
    languages: PlaybackLanguageAvailability | null;
  }>;
  prepareDirectPlayback(
    profileId: string,
    ref: MediaCandidateRef,
    titleId: string,
  ): Promise<PlaybackGrant>;
}

const PAGE = 50;
const profileParams = {
  type: "object",
  required: ["profileId"],
  additionalProperties: false,
  properties: { profileId: { type: "string", minLength: 1, maxLength: 120 } },
} as const;
const refBody = {
  providerId: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,79}$" },
  candidateId: { type: "string", minLength: 1, maxLength: 240 },
} as const;

function failure(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ error: { code, message } });
}

export function registerDirectSearchRoutes(
  app: FastifyInstance,
  core: StreamerCore,
  backend: DirectSearchBackend | undefined,
  now: () => Date,
): void {
  const unavailable = (reply: FastifyReply) =>
    failure(
      reply,
      503,
      "DIRECT_SEARCH_UNAVAILABLE",
      "Fast Search needs the home server's connected sources.",
    );

  app.get(
    "/api/v1/profiles/:profileId/direct-search/providers",
    { schema: { params: profileParams } },
    async (request, reply) => {
      if (!backend) return unavailable(reply);
      const { profileId } = request.params as { profileId: string };
      return { providers: await backend.directSearchProviders(profileId) };
    },
  );

  app.get(
    "/api/v1/profiles/:profileId/direct-search",
    {
      schema: {
        params: profileParams,
        querystring: {
          type: "object",
          required: ["provider", "q"],
          additionalProperties: false,
          properties: {
            provider: refBody.providerId,
            q: { type: "string", minLength: 1, maxLength: 200 },
            offset: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!backend) return unavailable(reply);
      const { profileId } = request.params as { profileId: string };
      const { provider, q, offset } = request.query as {
        provider: string;
        q: string;
        offset: number;
      };
      const query = q.trim();
      if (!query)
        return failure(reply, 400, "INVALID_REQUEST", "Enter a search term.");
      try {
        // One extra result tells the client whether another page exists.
        const found = await backend.directSearch(
          profileId,
          provider,
          query,
          offset,
          PAGE + 1,
        );
        return {
          provider,
          items: directSearchItems(query, found.slice(0, PAGE), offset),
          hasMore: found.length > PAGE,
        };
      } catch (error) {
        request.log.warn(
          { code: "DIRECT_SEARCH_FAILED", providerId: provider },
          "Fast Search provider query failed",
        );
        return failure(
          reply,
          502,
          "DIRECT_SEARCH_FAILED",
          error instanceof Error && /not connected/.test(error.message)
            ? error.message
            : "This source did not answer. Try again in a moment.",
        );
      }
    },
  );

  app.post(
    "/api/v1/profiles/:profileId/direct-search/details",
    {
      schema: {
        params: profileParams,
        body: {
          type: "object",
          required: ["providerId", "candidateIds"],
          additionalProperties: false,
          properties: {
            providerId: refBody.providerId,
            candidateIds: {
              type: "array",
              minItems: 1,
              maxItems: PAGE,
              items: refBody.candidateId,
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!backend) return unavailable(reply);
      const { profileId } = request.params as { profileId: string };
      const { providerId, candidateIds } = request.body as {
        providerId: string;
        candidateIds: string[];
      };
      try {
        const found =
          (await backend.directDetails?.(
            profileId,
            providerId,
            candidateIds,
          )) ?? [];
        return {
          items: found.map(({ candidateId, format }) => ({
            candidateId,
            format: format && {
              container: format.container,
              resolution: format.resolution,
              videoCodec: format.videoCodec,
              audioLanguages: format.audioLanguages,
              ...(format.details ? { details: format.details } : {}),
            },
          })),
        };
      } catch {
        return failure(
          reply,
          502,
          "DIRECT_DETAILS_FAILED",
          "File details are unavailable right now.",
        );
      }
    },
  );

  app.post(
    "/api/v1/profiles/:profileId/direct-search/inspect",
    {
      schema: {
        params: profileParams,
        body: {
          type: "object",
          required: ["providerId", "candidateId"],
          additionalProperties: false,
          properties: refBody,
        },
      },
    },
    async (request, reply) => {
      if (!backend) return unavailable(reply);
      const { profileId } = request.params as { profileId: string };
      const ref = request.body as MediaCandidateRef;
      try {
        return await backend.directInspect(profileId, ref);
      } catch {
        return failure(
          reply,
          502,
          "DIRECT_INSPECT_FAILED",
          "The file details could not be read. The file may no longer be available.",
        );
      }
    },
  );

  app.post(
    "/api/v1/profiles/:profileId/direct-search/play",
    {
      schema: {
        params: profileParams,
        body: {
          type: "object",
          required: ["providerId", "candidateId", "releaseName"],
          additionalProperties: false,
          properties: {
            ...refBody,
            releaseName: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!backend) return unavailable(reply);
      const { profileId } = request.params as { profileId: string };
      const { releaseName, ...ref } = request.body as MediaCandidateRef & {
        releaseName: string;
      };
      const titleId = directTitleId(ref);
      try {
        const playback = await backend.prepareDirectPlayback(
          profileId,
          ref,
          titleId,
        );
        return {
          ok: true,
          playback,
          title: directCatalogTitle(
            ref,
            releaseName,
            core.directPositions.get(profileId, titleId),
            now(),
          ),
        };
      } catch {
        return failure(
          reply,
          502,
          "DIRECT_PLAYBACK_FAILED",
          "This file could not be prepared for playback. It may no longer be available.",
        );
      }
    },
  );
}
