import type { FastifyInstance } from "fastify";
import {
  LOCAL_MEDIA_EXTENSIONS,
  type LocalMediaLibrary,
} from "../services/local-media-library.js";
import type { IntegrationStateStore } from "../stores/integration-state-store.js";
import type { OfflineDownloadManager } from "../services/offline-download-manager.js";
import { pickServerFolder } from "../services/native-folder-picker.js";

export function registerLocalFilesRoutes(
  app: FastifyInstance,
  library: LocalMediaLibrary,
  states: IntegrationStateStore,
  now: () => Date,
  downloads: OfflineDownloadManager,
  selectFolder: () => Promise<string | null> = pickServerFolder,
): void {
  let selectingFolder = false;
  const updateState = async () => {
    const configured = library.getConfig().roots.length > 0;
    await states.set({
      integrationId: "local-files",
      status: configured ? "connected" : "not_configured",
      configured,
      updatedAt: now().toISOString(),
    });
  };
  const config = () => ({
    ...library.getConfig(),
    availableExtensions: LOCAL_MEDIA_EXTENSIONS,
  });
  app.get("/api/v1/integrations/local-files", async () => ({
    ...config(),
  }));
  app.post(
    "/api/v1/integrations/local-files/select-folder",
    async (request, reply) => {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip))
        return reply
          .code(403)
          .send({
            error: {
              code: "FOLDER_PICKER_LOCAL_ONLY",
              message: "Open StreamerAI on the server to select a folder.",
            },
          });
      if (selectingFolder)
        return reply
          .code(409)
          .send({
            error: {
              code: "FOLDER_PICKER_BUSY",
              message: "A folder picker is already open.",
            },
          });
      selectingFolder = true;
      try {
        const path = await selectFolder();
        if (path === null) return reply.code(204).send();
        await library.addRoot(path);
        await updateState();
        return reply.code(201).send(config());
      } catch (error) {
        return reply
          .code(400)
          .send({
            error: {
              code: "FOLDER_PICKER_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : "The folder could not be selected.",
            },
          });
      } finally {
        selectingFolder = false;
      }
    },
  );
  app.delete("/api/v1/integrations/local-files", async (_request, reply) => {
    for (const root of library.getConfig().roots) {
      downloads.cancelRoot(root.id);
      downloads.forgetRoot(root.id);
    }
    library.disconnect();
    await updateState();
    return reply.code(204).send();
  });
  app.post(
    "/api/v1/integrations/local-files/roots",
    {
      schema: {
        body: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const root = await library.addRoot(
          (request.body as { path: string }).path,
        );
        await updateState();
        return reply.code(201).send({ root, ...config() });
      } catch (error) {
        return reply.code(400).send({
          error: {
            code: "LOCAL_FOLDER_INVALID",
            message:
              error instanceof Error
                ? error.message
                : "The folder could not be connected.",
          },
        });
      }
    },
  );
  app.delete(
    "/api/v1/integrations/local-files/roots/:rootId",
    {
      schema: {
        params: {
          type: "object",
          required: ["rootId"],
          additionalProperties: false,
          properties: { rootId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const rootId = (request.params as { rootId: string }).rootId;
      downloads.cancelRoot(rootId);
      const removed = library.removeRoot(rootId);
      if (!removed)
        return reply.code(404).send({
          error: {
            code: "LOCAL_FOLDER_NOT_FOUND",
            message: "This folder is not connected.",
          },
        });
      downloads.forgetRoot(rootId);
      await updateState();
      return config();
    },
  );
  app.put(
    "/api/v1/integrations/local-files/formats",
    {
      schema: {
        body: {
          type: "object",
          required: ["extensions"],
          additionalProperties: false,
          properties: {
            extensions: {
              type: "array",
              uniqueItems: true,
              maxItems: LOCAL_MEDIA_EXTENSIONS.length,
              items: { type: "string", enum: [...LOCAL_MEDIA_EXTENSIONS] },
            },
          },
        },
      },
    },
    async (request) => {
      library.setExtensions(
        (request.body as { extensions: string[] }).extensions,
      );
      return config();
    },
  );
  app.post("/api/v1/integrations/local-files/scan", async () => {
    library.startScan();
    return config();
  });

  const profileParams = {
    type: "object",
    required: ["profileId"],
    additionalProperties: false,
    properties: { profileId: { type: "string", minLength: 1, maxLength: 120 } },
  } as const;
  app.get(
    "/api/v1/profiles/:profileId/offline-downloads",
    { schema: { params: profileParams } },
    async (request) => ({
      items: downloads.list(
        (request.params as { profileId: string }).profileId,
      ),
    }),
  );
  app.post(
    "/api/v1/profiles/:profileId/offline-downloads",
    {
      schema: {
        params: profileParams,
        body: {
          type: "object",
          required: ["titleId", "sourceId", "rootId"],
          additionalProperties: false,
          properties: {
            titleId: { type: "string", minLength: 1, maxLength: 160 },
            sourceId: { type: "string", pattern: "^[a-f0-9]{32}$" },
            rootId: { type: "string", format: "uuid" },
            replaceExisting: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const job = downloads.start({
          profileId: (request.params as { profileId: string }).profileId,
          ...(request.body as {
            titleId: string;
            sourceId: string;
            rootId: string;
            replaceExisting?: boolean;
          }),
        });
        return reply.code(202).send(job);
      } catch (error) {
        return reply.code(400).send({
          error: {
            code: "OFFLINE_DOWNLOAD_REJECTED",
            message:
              error instanceof Error
                ? error.message
                : "Offline download could not start.",
          },
        });
      }
    },
  );
  app.delete(
    "/api/v1/profiles/:profileId/offline-downloads/:downloadId",
    {
      schema: {
        params: {
          type: "object",
          required: ["profileId", "downloadId"],
          additionalProperties: false,
          properties: {
            profileId: { type: "string", minLength: 1, maxLength: 120 },
            downloadId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (request, reply) => {
      const { profileId, downloadId } = request.params as {
        profileId: string;
        downloadId: string;
      };
      return downloads.cancel(downloadId, profileId)
        ? reply.code(204).send()
        : reply.code(404).send({
            error: {
              code: "OFFLINE_DOWNLOAD_NOT_FOUND",
              message: "Active download not found.",
            },
          });
    },
  );
}
