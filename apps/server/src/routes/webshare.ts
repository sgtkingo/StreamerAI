import type { FastifyInstance, FastifyReply } from "fastify";
import {
  WebshareClient,
  WebshareResponseError,
  WEBSHARE_WST_SECRET_KEY,
} from "../integrations/webshare-client.js";
import { ProviderRequestError } from "../integrations/provider-http.js";
import type { ProviderFetch } from "../integrations/tmdb-api-client.js";
import type { IntegrationStateStore } from "../stores/integration-state-store.js";
import type { SecretStore } from "../stores/secret-store.js";
import { profileSecretKey } from "../stores/secret-store.js";

export interface WebshareRouteDependencies {
  fetch: ProviderFetch;
  secretStore: SecretStore;
  integrationStateStore: IntegrationStateStore;
  profileExists?: (profileId: string) => boolean;
  timeoutMs: number;
  now: () => Date;
}

const credentialsBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["username", "password"],
  properties: {
    username: { type: "string", minLength: 1, maxLength: 254 },
    password: { type: "string", minLength: 1, maxLength: 1024 },
    profileId: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;

function sendFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof WebshareResponseError) {
    const credentialFailure =
      error.kind === "unauthorized" ||
      error.upstreamCode?.startsWith("SALT_FATAL") === true ||
      error.upstreamCode?.startsWith("LOGIN_FATAL") === true;
    return reply.code(credentialFailure ? 401 : 502).send({
      integrationId: "webshare",
      ok: false,
      status: credentialFailure ? "action-required" : "unavailable",
      messageCode: credentialFailure
        ? "CREDENTIAL_REJECTED"
        : error.kind === "invalid-response"
          ? "INVALID_RESPONSE"
          : "PROVIDER_UNAVAILABLE",
    });
  }
  if (error instanceof ProviderRequestError) {
    return reply.code(error.kind === "timeout" ? 504 : 502).send({
      integrationId: "webshare",
      ok: false,
      status: "unavailable",
      messageCode:
        error.kind === "timeout" ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
    });
  }
  throw error;
}

export function registerWebshareRoutes(
  app: FastifyInstance,
  dependencies: WebshareRouteDependencies,
): void {
  app.post(
    "/api/v1/integrations/webshare/connect",
    { schema: { body: credentialsBodySchema } },
    async (request, reply) => {
      const body = request.body as { username: string; password: string };
      const profileId =
        (request.body as { profileId?: string }).profileId ?? "default";
      if (dependencies.profileExists && !dependencies.profileExists(profileId))
        return reply.code(404).send({
          integrationId: "webshare",
          ok: false,
          status: "action-required",
          messageCode: "UNKNOWN",
        });
      const client = new WebshareClient({
        secretStore: dependencies.secretStore,
        fetch: dependencies.fetch,
        timeoutMs: dependencies.timeoutMs,
      });
      let token: string;
      try {
        token = await client.authenticate(body.username, body.password);
      } catch (error) {
        request.log.info(
          { integrationId: "webshare", code: "CONNECTION_CHECK_FAILED" },
          "Webshare connection check did not succeed",
        );
        return sendFailure(reply, error);
      }

      const secretKey = profileSecretKey(profileId, WEBSHARE_WST_SECRET_KEY);
      const previousToken = await dependencies.secretStore.get(secretKey);
      try {
        await dependencies.secretStore.set(secretKey, token);
        const timestamp = dependencies.now().toISOString();
        await dependencies.integrationStateStore.set(
          {
            integrationId: "webshare",
            status: "connected",
            configured: true,
            checkedAt: timestamp,
            updatedAt: timestamp,
          },
          profileId,
        );
      } catch {
        try {
          if (previousToken === undefined) {
            await dependencies.secretStore.delete(secretKey);
          } else {
            await dependencies.secretStore.set(secretKey, previousToken);
          }
        } catch {
          // Readiness exposes storage failure without logging the token.
        }
        return reply.code(500).send({
          integrationId: "webshare",
          ok: false,
          status: "unavailable",
          messageCode: "SECURE_STORAGE_UNAVAILABLE",
        });
      }

      return reply.send({
        integrationId: "webshare",
        ok: true,
        status: "connected",
        messageCode: "CONNECTED",
        persistence:
          dependencies.secretStore.persistence === "memory"
            ? "memory"
            : "secure-local",
      });
    },
  );

  app.delete("/api/v1/integrations/webshare", async (request, reply) => {
    const profileId =
      (request.query as { profileId?: string }).profileId ?? "default";
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send();
    const secretKey = profileSecretKey(profileId, WEBSHARE_WST_SECRET_KEY);
    try {
      await dependencies.secretStore.delete(secretKey);
      await dependencies.integrationStateStore.delete("webshare", profileId);
      return reply.code(204).send();
    } catch {
      return reply.code(500).send({
        integrationId: "webshare",
        ok: false,
        status: "unavailable",
        messageCode: "SECURE_STORAGE_UNAVAILABLE",
      });
    }
  });
}
