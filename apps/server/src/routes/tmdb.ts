import type { FastifyInstance, FastifyReply } from "fastify";
import {
  checkTmdbConnection,
  TMDB_READ_TOKEN_SECRET_KEY,
  type FetchLike,
  type TmdbConnectionCheck,
} from "../integrations/tmdb-client.js";
import type { IntegrationStateStore } from "../stores/integration-state-store.js";
import type { SecretStore } from "../stores/secret-store.js";
import { profileSecretKey } from "../stores/secret-store.js";

export interface TmdbRouteDependencies {
  fetch: FetchLike;
  secretStore: SecretStore;
  integrationStateStore: IntegrationStateStore;
  profileExists?: (profileId: string) => boolean;
  timeoutMs: number;
  now: () => Date;
}

const tokenBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    token: { type: "string", maxLength: 2048 },
    profileId: { type: "string", minLength: 1, maxLength: 120 },
  },
} as const;

function sendCheckFailure(reply: FastifyReply, result: TmdbConnectionCheck) {
  if (result.ok) {
    throw new Error("Expected a failed TMDB connection check");
  }

  if (result.kind === "unauthorized" || result.kind === "forbidden") {
    return reply.code(401).send({
      integrationId: "tmdb",
      ok: false,
      status: "action-required",
      messageCode: "CREDENTIAL_REJECTED",
    });
  }

  if (result.kind === "timeout") {
    return reply.code(504).send({
      integrationId: "tmdb",
      ok: false,
      status: "unavailable",
      messageCode: "TIMEOUT",
    });
  }

  const messageCode =
    result.kind === "rate_limited"
      ? "RATE_LIMITED"
      : result.kind === "invalid_response"
        ? "INVALID_RESPONSE"
        : "PROVIDER_UNAVAILABLE";

  return reply.code(502).send({
    integrationId: "tmdb",
    ok: false,
    status: "unavailable",
    messageCode,
  });
}

async function verify(
  token: string | undefined,
  dependencies: TmdbRouteDependencies,
) {
  const cleanToken = token?.trim().replace(/^Bearer\s+/i, "");
  if (
    cleanToken === undefined ||
    cleanToken.length < 20 ||
    cleanToken.length > 2_048
  ) {
    return { token: undefined, result: undefined } as const;
  }

  const result = await checkTmdbConnection({
    token: cleanToken,
    fetch: dependencies.fetch,
    timeoutMs: dependencies.timeoutMs,
    now: dependencies.now,
  });
  return { token: cleanToken, result } as const;
}

export function registerTmdbRoutes(
  app: FastifyInstance,
  dependencies: TmdbRouteDependencies,
): void {
  app.post(
    "/api/v1/integrations/tmdb/check",
    { schema: { body: tokenBodySchema } },
    async (request, reply) => {
      const verification = await verify(
        (request.body as { token?: string } | undefined)?.token,
        dependencies,
      );
      if (
        verification.token === undefined ||
        verification.result === undefined
      ) {
        return reply.code(400).send({
          integrationId: "tmdb",
          ok: false,
          status: "action-required",
          messageCode: "CREDENTIAL_REQUIRED",
        });
      }
      if (!verification.result.ok) {
        request.log.info(
          { integrationId: "tmdb", code: verification.result.kind },
          "TMDB connection check did not succeed",
        );
        return sendCheckFailure(reply, verification.result);
      }

      return reply.send({
        integrationId: "tmdb",
        ok: true,
        status: "verified",
        messageCode: "VERIFIED",
      });
    },
  );

  app.post(
    "/api/v1/integrations/tmdb/connect",
    { schema: { body: tokenBodySchema } },
    async (request, reply) => {
      const verification = await verify(
        (request.body as { token?: string } | undefined)?.token,
        dependencies,
      );
      const profileId =
        (request.body as { profileId?: string } | undefined)?.profileId ??
        "default";
      if (dependencies.profileExists && !dependencies.profileExists(profileId))
        return reply.code(404).send({
          integrationId: "tmdb",
          ok: false,
          status: "action-required",
          messageCode: "UNKNOWN",
        });
      if (
        verification.token === undefined ||
        verification.result === undefined
      ) {
        return reply.code(400).send({
          integrationId: "tmdb",
          ok: false,
          status: "action-required",
          messageCode: "CREDENTIAL_REQUIRED",
        });
      }
      if (!verification.result.ok) {
        request.log.info(
          { integrationId: "tmdb", code: verification.result.kind },
          "TMDB connection check did not succeed",
        );
        return sendCheckFailure(reply, verification.result);
      }

      const secretKey = profileSecretKey(profileId, TMDB_READ_TOKEN_SECRET_KEY);
      const previousToken = await dependencies.secretStore.get(secretKey);
      try {
        await dependencies.secretStore.set(secretKey, verification.token);
        await dependencies.integrationStateStore.set(
          {
            integrationId: "tmdb",
            status: "connected",
            configured: true,
            checkedAt: verification.result.checkedAt,
            updatedAt: dependencies.now().toISOString(),
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
          // The response remains sanitized. Readiness diagnostics expose the
          // store failure without ever emitting a secret value.
        }

        request.log.error(
          { integrationId: "tmdb", code: "INTEGRATION_STORAGE_FAILED" },
          "Could not save TMDB integration state",
        );
        return reply.code(500).send({
          integrationId: "tmdb",
          ok: false,
          status: "unavailable",
          messageCode: "SECURE_STORAGE_UNAVAILABLE",
        });
      }

      return reply.send({
        integrationId: "tmdb",
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

  app.delete("/api/v1/integrations/tmdb", async (request, reply) => {
    const profileId =
      (request.query as { profileId?: string }).profileId ?? "default";
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send();
    const secretKey = profileSecretKey(profileId, TMDB_READ_TOKEN_SECRET_KEY);
    try {
      await dependencies.secretStore.delete(secretKey);
      await dependencies.integrationStateStore.delete("tmdb", profileId);
      return reply.code(204).send();
    } catch {
      return reply.code(500).send({
        integrationId: "tmdb",
        ok: false,
        status: "unavailable",
        messageCode: "SECURE_STORAGE_UNAVAILABLE",
      });
    }
  });
}
