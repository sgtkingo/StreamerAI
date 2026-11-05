import type { FastifyInstance } from "fastify";
import { arch, platform } from "node:os";

export const SERVER_VERSION = "0.1.0";
/** Explicit allowlist: never return environment variables, paths, logs or account data. */
export function deploymentDiagnostics() {
  return {
    format: "streamerai-diagnostics-v1",
    generatedAt: new Date().toISOString(),
    serverVersion: SERVER_VERSION,
    apiProtocol: 1,
    platform: platform(),
    architecture: arch(),
    nodeMajor: Number(process.versions.node.split(".")[0]),
    includesLogs: false,
    includesPersonalData: false,
  };
}

export function registerDeploymentRoutes(app: FastifyInstance) {
  app.get("/api/v1/server/version", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      serverVersion: SERVER_VERSION,
      apiProtocol: 1,
      minimumClientProtocol: 1,
    };
  });
  app.get("/api/v1/server/diagnostics", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return deploymentDiagnostics();
  });
}
