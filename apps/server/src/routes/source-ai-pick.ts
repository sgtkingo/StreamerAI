import { randomUUID } from "node:crypto";
import {
  SourceAiPickRequestSchema,
  type AgentProvider,
} from "@streamer-ai/contracts";
import type { StreamerDatabase } from "@streamer-ai/database";
import type { FastifyInstance } from "fastify";
import { PreferredSourceStore } from "../services/preferred-source-store.js";
import { suggestSource } from "../services/source-ai-pick.js";

export function registerSourceAiPickRoutes(
  app: FastifyInstance,
  dependencies: {
    database: StreamerDatabase;
    agent: AgentProvider;
    inference: (profileId: string) => { model: string; contextTokens: number };
  },
) {
  const { database } = dependencies;
  const preferred = new PreferredSourceStore(database);
  const pending = new Set<string>();
  app.post(
    "/api/v1/profiles/:profileId/titles/:titleId/ai-pick",
    async (request, reply) => {
      const { profileId, titleId } = request.params as {
        profileId: string;
        titleId: string;
      };
      const profile = database.profiles.get(profileId);
      const title = database.titles.get(titleId);
      if (!profile || !title) return reply.code(404).send();
      const parsed = SourceAiPickRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "Choose a valid source list and exact episode.",
          },
        });
      const { episode, sources } = parsed.data;
      if (
        (title.kind === "series") !== Boolean(episode) ||
        sources.some((source) =>
          episode
            ? source.seasonNumber !== episode.seasonNumber ||
              source.episodeNumber !== episode.episodeNumber
            : source.seasonNumber !== null || source.episodeNumber !== null,
        ) ||
        new Set(sources.map((source) => source.id)).size !== sources.length
      )
        return reply.code(400).send({
          error: {
            code: "INVALID_SOURCES",
            message: "Choose sources for this movie or exact episode.",
          },
        });
      // At most one model call per profile; callers cannot queue repeated clicks.
      if (pending.has(profileId))
        return reply.code(409).send({
          error: {
            code: "AI_PICK_BUSY",
            message: "AI is already choosing a source. Please wait.",
          },
        });
      pending.add(profileId);
      const revision = preferred.revision(profileId, titleId, episode);
      try {
        const result = await suggestSource(
          dependencies.agent,
          {
            title: {
              title: title.title,
              originalTitle: title.originalTitle,
              year: title.year,
              kind: title.kind,
            },
            episode,
            sources,
            ...dependencies.inference(profileId),
          },
          {
            requestId: randomUUID(),
            profileId,
            locale: profile.locale,
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            secretRef: null,
            signal: AbortSignal.timeout(60_000),
          },
        );
        const applied =
          result.sourceId !== null &&
          database.profiles.get(profileId) !== null &&
          preferred.revision(profileId, titleId, episode) === revision;
        if (applied && result.sourceId)
          preferred.setAi(
            profileId,
            titleId,
            result.sourceId,
            result.reason,
            episode,
          );
        return { ...result, applied };
      } catch (error) {
        const tooLarge =
          error instanceof Error && error.message === "SOURCE_LIST_TOO_LARGE";
        return reply.code(tooLarge ? 413 : 503).send({
          error: {
            code: tooLarge ? "SOURCE_LIST_TOO_LARGE" : "AI_PICK_UNAVAILABLE",
            message: tooLarge
              ? "This source list exceeds the configured AI context. Increase the agent context size and try again."
              : "AI could not choose a source. The current selection is still available.",
          },
        });
      } finally {
        pending.delete(profileId);
      }
    },
  );
}
