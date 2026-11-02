import {
  SourceFeedbackSettingsSchema,
  SourceFeedbackRequestSchema,
} from "@streamer-ai/contracts";
import type { StreamerDatabase } from "@streamer-ai/database";
import type { FastifyInstance } from "fastify";

export function registerSourceFeedbackRoutes(
  app: FastifyInstance,
  database: StreamerDatabase,
): void {
  const settingsPath = "/api/v1/profiles/:profileId/source-feedback-settings";
  app.get(settingsPath, async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const profile = database.profiles.get(profileId);
    if (!profile) return reply.code(404).send();
    return { enabled: profile.preferences.sourceFeedbackEnabled !== false };
  });
  app.put(settingsPath, async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    const profile = database.profiles.get(profileId);
    if (!profile) return reply.code(404).send();
    const parsed = SourceFeedbackSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send();
    database.profiles.update(profileId, {
      preferences: {
        ...profile.preferences,
        sourceFeedbackEnabled: parsed.data.enabled,
      },
    });
    return parsed.data;
  });
  const feedbackPath =
    "/api/v1/profiles/:profileId/titles/:titleId/source-feedback";
  const result = (
    accountId: string,
    profileSyncId: string,
    titleId: string,
    enabled: boolean,
  ) => ({
    enabled,
    items: enabled
      ? database.sourceFeedback
          .list(accountId, titleId)
          .map((item) => ({
            ...item.payload,
            isOwn: item.payload.profileId === profileSyncId,
          }))
      : [],
  });
  app.get(feedbackPath, async (request, reply) => {
    const { profileId, titleId } = request.params as {
      profileId: string;
      titleId: string;
    };
    const profile = database.profiles.get(profileId);
    if (!profile || !database.titles.get(titleId))
      return reply.code(404).send();
    return result(
      profile.accountId,
      profile.syncId,
      titleId,
      profile.preferences.sourceFeedbackEnabled !== false,
    );
  });
  app.put(feedbackPath, async (request, reply) => {
    const { profileId, titleId } = request.params as {
      profileId: string;
      titleId: string;
    };
    const profile = database.profiles.get(profileId);
    const title = database.titles.get(titleId);
    if (!profile || !title) return reply.code(404).send();
    if (profile.preferences.sourceFeedbackEnabled === false)
      return reply.code(409).send({
        error: {
          code: "SOURCE_FEEDBACK_DISABLED",
          message: "Source feedback is disabled for this profile.",
        },
      });
    const parsed = SourceFeedbackRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send();
    const source = title.sources?.find(
      (item) => item.id === parsed.data.sourceId,
    );
    if (!source)
      return reply.code(404).send({
        error: {
          code: "SOURCE_NOT_FOUND",
          message: "Refresh the title's sources and try again.",
        },
      });
    database.sourceFeedback.set(profile.accountId, {
      profileId: profile.syncId,
      titleId,
      providerId: source.providerId,
      candidateId: source.candidateId,
      seasonNumber: source.seasonNumber,
      episodeNumber: source.episodeNumber,
      vote: parsed.data.vote,
    });
    return result(profile.accountId, profile.syncId, titleId, true);
  });
}
