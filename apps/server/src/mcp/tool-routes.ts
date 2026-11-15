/**
 * The only business routes StreamerAI tool bridges (the external stdio MCP
 * bridge and the embedded agent) call. Machine credentials are honoured only
 * here, and only from loopback.
 */
const TOOL_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /^\/api\/v1\/discovery\/sessions$/],
  ["GET", /^\/api\/v1\/profiles\/[^/]+\/titles\/[^/]+$/],
  ["POST", /^\/api\/v1\/profiles\/[^/]+\/playback\/start$/],
  ["GET", /^\/api\/v1\/playback\/grants\/[^/]+\/manifest$/],
  ["DELETE", /^\/api\/v1\/playback\/grants\/[^/]+$/],
  // The bridge announces itself when its host loads it.
  ["POST", /^\/api\/v1\/profiles\/[^/]+\/mcp\/bridge$/],
];

export const LOOPBACK_ADDRESSES: readonly string[] = [
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
];

export function isToolRoute(method: string, path: string): boolean {
  return TOOL_ROUTES.some(
    ([allowed, pattern]) => allowed === method && pattern.test(path),
  );
}

/**
 * Routes of the user-side agent connector. It has no session; the handler
 * accepts only a one-time ticket created by the household owner.
 */
export function isConnectorRoute(method: string, path: string): boolean {
  return (
    method === "POST" &&
    /^\/api\/v1\/mcp\/connector\/(?:redeem|report)$/.test(path)
  );
}
