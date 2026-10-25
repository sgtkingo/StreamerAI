import { MediaSourcePreferencesSchema } from "@streamer-ai/contracts";
import type { FastifyInstance } from "fastify";
import type { StreamerDatabase } from "@streamer-ai/database";
import type { MediaSourcePreferenceStore } from "../services/media-source-preferences.js";

export function registerMediaSourcePreferenceRoutes(
  app: FastifyInstance,
  dependencies: {
    database: StreamerDatabase;
    store: MediaSourcePreferenceStore;
    providerIds: () => readonly string[];
  },
): void {
  const path = "/api/v1/profiles/:profileId/media-source-preferences";
  app.get(path, async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    if (!dependencies.database.profiles.get(profileId))
      return reply.code(404).send();
    return {
      providerOrder: dependencies.store.order(
        profileId,
        dependencies.providerIds(),
      ),
    };
  });
  app.put(path, async (request, reply) => {
    const { profileId } = request.params as { profileId: string };
    if (!dependencies.database.profiles.get(profileId))
      return reply.code(404).send();
    const parsed = MediaSourcePreferencesSchema.safeParse(request.body);
    const known = dependencies.providerIds();
    if (
      !parsed.success ||
      parsed.data.providerOrder.some((id) => !known.includes(id))
    )
      return reply.code(400).send({
        error: {
          code: "INVALID_SOURCE_ORDER",
          message: "Choose each stream source at most once.",
        },
      });
    dependencies.store.set(profileId, parsed.data.providerOrder);
    return { providerOrder: dependencies.store.order(profileId, known) };
  });
}
