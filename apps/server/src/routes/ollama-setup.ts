import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ServerAiSetupError,
  type ServerAiSetupService,
} from "../services/ollama-setup.js";

export function registerServerAiSetupRoutes(
  app: FastifyInstance,
  options: {
    service: ServerAiSetupService;
    requireOwner(
      request: FastifyRequest,
      reply: FastifyReply,
    ): boolean | Promise<boolean>;
  },
) {
  app.get("/api/v1/server/ai-setup", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!(await options.requireOwner(request, reply))) return;
    try {
      return await options.service.status();
    } catch {
      return reply.code(503).send({
        error: {
          code: "OLLAMA_SETUP_UNAVAILABLE",
          message: "Local AI setup could not be checked right now.",
        },
      });
    }
  });
  app.post("/api/v1/server/ai-setup/model", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!(await options.requireOwner(request, reply))) return;
    const body = request.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !("confirm" in body) ||
      body.confirm !== "download-recommended-local-model" ||
      Object.keys(body).length !== 1
    )
      return reply.code(400).send({
        error: {
          code: "LOCAL_MODEL_CONSENT_REQUIRED",
          message: "Confirm downloading the recommended local model.",
        },
      });
    try {
      return await options.service.startModelDownload();
    } catch (error) {
      const code =
        error instanceof ServerAiSetupError
          ? error.code
          : "OLLAMA_SETUP_UNAVAILABLE";
      return reply.code(409).send({
        error: {
          code,
          message:
            code === "OLLAMA_RUNTIME_REQUIRED"
              ? "Open StreamerAI Setup on the server and choose Configure local AI."
              : code === "OLLAMA_MODEL_DISK_SPACE"
                ? "The server needs more free disk space for this model."
                : "Local AI setup is unavailable.",
        },
      });
    }
  });
  app.addHook("onClose", async () => options.service.close());
}
