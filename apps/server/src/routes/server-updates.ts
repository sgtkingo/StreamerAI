import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ServerUpdateError,
  type ServerUpdateService,
} from "../services/server-updates.js";

const MESSAGES: Record<ServerUpdateError["code"], [number, string]> = {
  UPDATES_UNSUPPORTED: [
    409,
    "Automatic updates are available for installed Windows servers.",
  ],
  UPDATE_NOT_AVAILABLE: [409, "No newer StreamerAI release is available."],
  UPDATE_NOT_DOWNLOADED: [409, "Download the update before installing it."],
  UPDATE_VERSION_CHANGED: [
    409,
    "The offered update changed. Check for updates again.",
  ],
  UPDATE_BUSY: [409, "An update is already being installed."],
  PLAYBACK_ACTIVE: [
    409,
    "Someone is watching right now. Install anyway or try again later.",
  ],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function registerServerUpdateRoutes(
  app: FastifyInstance,
  options: {
    service: ServerUpdateService;
    requireOwner(
      request: FastifyRequest,
      reply: FastifyReply,
    ): boolean | Promise<boolean>;
  },
) {
  const { service } = options;
  const handle = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<unknown>,
  ) => {
    reply.header("cache-control", "no-store");
    if (!(await options.requireOwner(request, reply))) return;
    try {
      return await action();
    } catch (error) {
      if (error instanceof ServerUpdateError) {
        const [status, message] = MESSAGES[error.code];
        return reply
          .code(status)
          .send({ error: { code: error.code, message } });
      }
      throw error;
    }
  };
  const invalid = (reply: FastifyReply, message: string) =>
    reply
      .code(400)
      .send({ error: { code: "INVALID_UPDATE_REQUEST", message } });

  app.get("/api/v1/server/updates", (request, reply) =>
    handle(request, reply, () => service.status()),
  );
  app.post("/api/v1/server/updates/check", (request, reply) =>
    handle(request, reply, () => service.check()),
  );
  app.post("/api/v1/server/updates/download", (request, reply) =>
    handle(request, reply, () => service.download()),
  );
  app.post("/api/v1/server/updates/install", (request, reply) => {
    const body = request.body;
    if (
      !isObject(body) ||
      body.confirm !== "install-server-update" ||
      typeof body.version !== "string" ||
      (body.allowDuringPlayback !== undefined &&
        typeof body.allowDuringPlayback !== "boolean")
    )
      return invalid(reply, "Confirm the update version to install.");
    return handle(request, reply, () =>
      service.install(body.version as string, {
        allowDuringPlayback: body.allowDuringPlayback === true,
      }),
    );
  });
  app.put("/api/v1/server/updates/settings", (request, reply) => {
    const body = request.body;
    if (
      !isObject(body) ||
      Object.keys(body).some(
        (key) => !["autoDownload", "nightlyInstall"].includes(key),
      ) ||
      Object.values(body).some((value) => typeof value !== "boolean")
    )
      return invalid(reply, "Update settings must be true or false.");
    return handle(request, reply, () =>
      service.updateSettings(
        body as { autoDownload?: boolean; nightlyInstall?: boolean },
      ),
    );
  });
  app.post("/api/v1/server/updates/remind-later", (request, reply) =>
    handle(request, reply, () => service.remindLater(24)),
  );
  app.addHook("onClose", async () => service.close());
}
