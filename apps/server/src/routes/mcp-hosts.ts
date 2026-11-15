import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  mcpConnectorLink,
  type McpConnectorTickets,
} from "../mcp/mcp-connector.js";
import {
  isMcpHostId,
  McpHostConfigError,
  type McpAccessTokens,
  type McpBridgeCommand,
  type McpHostId,
  type McpHostInstaller,
} from "../mcp/mcp-host-installer.js";
import { LOOPBACK_ADDRESSES } from "../mcp/tool-routes.js";

export interface McpHostRouteDependencies {
  installer: McpHostInstaller;
  /** Whether the caller may change agent host files on the server computer. */
  canManage: (request: FastifyRequest) => boolean;
  tokens: McpAccessTokens;
  tickets: McpConnectorTickets;
  /** The user-side connector script, when this build ships it. */
  connector: () => McpBridgeCommand | null;
}

/** A copyable command that starts the connector in the current user's shell. */
function connectorCommand(connector: McpBridgeCommand, link: string) {
  const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
  const command = [connector.command, ...connector.args, link]
    .map(quote)
    .join(" ");
  return process.platform === "win32" ? `& ${command}` : command;
}

function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ error: { code, message } });
}

export function registerMcpHostRoutes(
  app: FastifyInstance,
  {
    installer,
    canManage,
    tokens,
    tickets,
    connector,
  }: McpHostRouteDependencies,
): void {
  const guard = (request: FastifyRequest, reply: FastifyReply) => {
    if (canManage(request)) return true;
    void fail(
      reply,
      403,
      "INSTALLATION_OWNER_REQUIRED",
      "Open StreamerAI on the server computer as its owner to connect agent hosts.",
    );
    return false;
  };
  const failure = (reply: FastifyReply, cause: unknown) =>
    fail(
      reply,
      cause instanceof McpHostConfigError ? 409 : 500,
      cause instanceof McpHostConfigError
        ? "MCP_HOST_CONFIG_FAILED"
        : "MCP_HOST_FAILED",
      cause instanceof McpHostConfigError
        ? cause.message
        : "The agent host configuration could not be changed.",
    );
  const overview = async (request: FastifyRequest, profileId: string) => ({
    canManage: canManage(request),
    ...(canManage(request)
      ? await installer.overview(profileId)
      : {
          bridge: { available: true },
          serviceAccount: false,
          connector: { available: false },
          hosts: [],
        }),
  });
  const sameComputer = (request: FastifyRequest) =>
    LOOPBACK_ADDRESSES.includes(request.ip) && !request.headers.origin;

  app.get<{ Params: { profileId: string } }>(
    "/api/v1/profiles/:profileId/mcp/hosts",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return overview(request, request.params.profileId);
    },
  );

  /** One-click connect: installs into the requested or all detected hosts. */
  app.post<{ Params: { profileId: string }; Body: { hosts?: unknown } }>(
    "/api/v1/profiles/:profileId/mcp/hosts",
    async (request, reply) => {
      if (!guard(request, reply)) return reply;
      const { profileId } = request.params;
      const requested = request.body?.hosts;
      if (
        requested !== undefined &&
        (!Array.isArray(requested) || !requested.every(isMcpHostId))
      )
        return fail(
          reply,
          400,
          "INVALID_MCP_HOST",
          "Choose a supported agent host.",
        );
      const before = await installer.overview(profileId);
      if (!before.bridge.available)
        return fail(
          reply,
          409,
          "MCP_BRIDGE_MISSING",
          before.bridge.message ?? "The MCP bridge is unavailable.",
        );
      const targets: McpHostId[] =
        (requested as McpHostId[] | undefined) ??
        before.hosts
          .filter((host) => host.state !== "not-detected")
          .map((host) => host.id);
      const failures: { id: McpHostId; message: string }[] = [];
      for (const id of targets) {
        if (before.hosts.find((host) => host.id === id)?.state === "installed")
          continue;
        try {
          await installer.install(profileId, id);
        } catch (cause) {
          failures.push({
            id,
            message:
              cause instanceof McpHostConfigError
                ? cause.message
                : "The host configuration could not be changed.",
          });
        }
      }
      reply.header("cache-control", "no-store");
      return { ...(await overview(request, profileId)), failures };
    },
  );

  app.delete<{ Params: { profileId: string; hostId: string } }>(
    "/api/v1/profiles/:profileId/mcp/hosts/:hostId",
    async (request, reply) => {
      if (!guard(request, reply)) return reply;
      const { profileId, hostId } = request.params;
      if (!isMcpHostId(hostId))
        return fail(
          reply,
          400,
          "INVALID_MCP_HOST",
          "Choose a supported agent host.",
        );
      try {
        await installer.remove(profileId, hostId);
      } catch (cause) {
        return failure(reply, cause);
      }
      reply.header("cache-control", "no-store");
      return overview(request, profileId);
    },
  );

  app.post<{ Params: { profileId: string } }>(
    "/api/v1/profiles/:profileId/mcp/manual",
    async (request, reply) => {
      if (!guard(request, reply)) return reply;
      try {
        reply.header("cache-control", "no-store");
        return await installer.manual(request.params.profileId);
      } catch (cause) {
        return failure(reply, cause);
      }
    },
  );

  /** Starts the user-side connector: a one-time ticket for a `streamerai-agent:` link. */
  app.post<{ Params: { profileId: string } }>(
    "/api/v1/profiles/:profileId/mcp/connector",
    async (request, reply) => {
      if (!guard(request, reply)) return reply;
      const script = connector();
      if (!script)
        return fail(
          reply,
          409,
          "MCP_BRIDGE_MISSING",
          "The agent connector is missing from this server build.",
        );
      const { ticket, expiresAt } = tickets.create(request.params.profileId);
      const url = mcpConnectorLink(installer.baseUrl, ticket);
      reply.header("cache-control", "no-store");
      return { ticket, url, expiresAt, command: connectorCommand(script, url) };
    },
  );

  app.get<{ Params: { profileId: string; ticket: string } }>(
    "/api/v1/profiles/:profileId/mcp/connector/:ticket",
    async (request, reply) => {
      if (!guard(request, reply)) return reply;
      reply.header("cache-control", "no-store");
      return tickets.status(request.params.ticket, request.params.profileId);
    },
  );

  app.post<{ Body: { ticket?: unknown; hosts?: unknown; detected?: unknown } }>(
    "/api/v1/mcp/connector/redeem",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const redeemed = sameComputer(request)
        ? await tickets.redeem(
            String(request.body?.ticket ?? ""),
            request.body?.hosts,
            request.body?.detected,
          )
        : null;
      if (!redeemed)
        return fail(
          reply,
          403,
          "MCP_CONNECTOR_TICKET_INVALID",
          "This connect link has expired or was already used.",
        );
      return redeemed;
    },
  );

  app.post<{ Body: { ticket?: unknown; results?: unknown } }>(
    "/api/v1/mcp/connector/report",
    async (request, reply) => {
      const accepted =
        sameComputer(request) &&
        (await tickets.report(
          String(request.body?.ticket ?? ""),
          request.body?.results,
        ));
      if (!accepted)
        return fail(
          reply,
          403,
          "MCP_CONNECTOR_TICKET_INVALID",
          "This connect link has expired or was already used.",
        );
      return { ok: true };
    },
  );

  /** The bridge announces that its host loaded it, which ends "restart required". */
  app.post<{ Params: { profileId: string } }>(
    "/api/v1/profiles/:profileId/mcp/bridge",
    async (request, reply) => {
      const token = request.headers["x-streamer-mcp-token"];
      const seen =
        typeof token === "string" ? await tokens.markSeen(token) : null;
      if (!seen)
        return fail(
          reply,
          401,
          "MCP_TOKEN_INVALID",
          "Reconnect StreamerAI in the agent host from StreamerAI Settings.",
        );
      return { ok: true, profileId: request.params.profileId };
    },
  );
}
