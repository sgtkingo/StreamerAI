import type { FastifyInstance, FastifyReply } from "fastify";
import {
  HellspyClient,
  HELLSPY_SESSION_SECRET_KEY,
} from "../integrations/hellspy-client.js";
import { ProviderRequestError } from "../integrations/provider-http.js";
import { profileSecretKey, type SecretStore } from "../stores/secret-store.js";
import type { IntegrationStateStore } from "../stores/integration-state-store.js";

interface Dependencies {
  client: HellspyClient;
  secretStore: SecretStore;
  integrationStateStore: IntegrationStateStore;
  profileExists: (profileId: string) => boolean;
  now: () => Date;
}
function sendFailure(reply: FastifyReply, error: unknown) {
  if (!(error instanceof ProviderRequestError)) throw error;
  const credentials =
    error.kind === "unauthorized" || error.kind === "not-configured";
  const code = credentials
    ? "CREDENTIAL_REJECTED"
    : error.kind === "timeout"
      ? "TIMEOUT"
      : error.kind === "rate-limited"
        ? "RATE_LIMITED"
        : error.kind === "invalid-response"
          ? "INVALID_RESPONSE"
          : "PROVIDER_UNAVAILABLE";
  return reply
    .code(
      credentials
        ? 401
        : error.kind === "timeout"
          ? 504
          : error.kind === "rate-limited"
            ? 429
            : 502,
    )
    .send({
      integrationId: "hellspy",
      ok: false,
      status: credentials ? "action-required" : "unavailable",
      messageCode: code,
    });
}
const profileProperty = {
  type: "string",
  minLength: 1,
  maxLength: 120,
} as const;
const profileSchema = {
  type: "object",
  additionalProperties: false,
  properties: { profileId: profileProperty },
} as const;
export function registerHellspyRoutes(
  app: FastifyInstance,
  dependencies: Dependencies,
): void {
  const success = () => ({
    integrationId: "hellspy",
    ok: true,
    status: "connected",
    messageCode: "CONNECTED",
    persistence:
      dependencies.secretStore.persistence === "memory"
        ? "memory"
        : "secure-local",
  });
  const saveState = (profileId: string, configured: boolean) => {
    const timestamp = dependencies.now().toISOString();
    return dependencies.integrationStateStore.set(
      {
        integrationId: "hellspy",
        status: configured ? "connected" : "action_required",
        configured,
        checkedAt: timestamp,
        updatedAt: timestamp,
      },
      profileId,
    );
  };
  app.post(
    "/api/v1/integrations/hellspy/connect",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["username", "password"],
          properties: {
            username: {
              type: "string",
              minLength: 1,
              maxLength: 254,
              pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
            },
            password: { type: "string", minLength: 1, maxLength: 1024 },
            profileId: profileProperty,
          },
        },
      },
    },
    async (request, reply) => {
      const {
        username,
        password,
        profileId = "default",
      } = request.body as {
        username: string;
        password: string;
        profileId?: string;
      };
      if (!dependencies.profileExists(profileId)) return reply.code(404).send();
      let session;
      try {
        session = await dependencies.client.authenticate(username, password);
      } catch (error) {
        return sendFailure(reply, error);
      }
      const key = profileSecretKey(profileId, HELLSPY_SESSION_SECRET_KEY);
      const previous = await dependencies.secretStore.get(key);
      try {
        await dependencies.secretStore.set(key, JSON.stringify(session));
        await saveState(profileId, true);
      } catch {
        try {
          if (previous === undefined)
            await dependencies.secretStore.delete(key);
          else await dependencies.secretStore.set(key, previous);
        } catch {
          /* Never expose storage exceptions or session data. */
        }
        return reply.code(500).send({
          integrationId: "hellspy",
          ok: false,
          status: "unavailable",
          messageCode: "SECURE_STORAGE_UNAVAILABLE",
        });
      }
      return success();
    },
  );
  app.post(
    "/api/v1/integrations/hellspy/check",
    { schema: { body: profileSchema } },
    async (request, reply) => {
      const { profileId = "default" } = (request.body ?? {}) as {
        profileId?: string;
      };
      if (!dependencies.profileExists(profileId)) return reply.code(404).send();
      try {
        await dependencies.client.authorize(profileId);
      } catch (error) {
        if (
          error instanceof ProviderRequestError &&
          ["unauthorized", "not-configured"].includes(error.kind)
        )
          await saveState(profileId, false);
        return sendFailure(reply, error);
      }
      await saveState(profileId, true);
      return success();
    },
  );
  app.delete(
    "/api/v1/integrations/hellspy",
    { schema: { querystring: profileSchema } },
    async (request, reply) => {
      const { profileId = "default" } = request.query as { profileId?: string };
      if (!dependencies.profileExists(profileId)) return reply.code(404).send();
      try {
        await dependencies.secretStore.delete(
          profileSecretKey(profileId, HELLSPY_SESSION_SECRET_KEY),
        );
        await dependencies.integrationStateStore.delete("hellspy", profileId);
        return reply.code(204).send();
      } catch {
        return reply.code(500).send({
          integrationId: "hellspy",
          ok: false,
          status: "unavailable",
          messageCode: "SECURE_STORAGE_UNAVAILABLE",
        });
      }
    },
  );
}
