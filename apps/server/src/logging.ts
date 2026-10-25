import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

export const LOG_REDACTION_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "authorization",
  "token",
  "accessToken",
  "readAccessToken",
  "apiKey",
  "api_key",
  "password",
  "wst",
  "body.authorization",
  "body.token",
  "body.accessToken",
  "body.readAccessToken",
  "body.apiKey",
  "body.password",
  "body.wst",
  "credentials.*",
] as const;

function requestSerializer(request: Record<string, unknown>) {
  const rawUrl = typeof request.url === "string" ? request.url : undefined;
  const path = rawUrl
    ?.split("?", 1)[0]
    ?.replace(/(\/api\/v1\/playback\/grants\/)[^/]+/g, "$1[REDACTED]");

  return {
    id: request.id,
    method: request.method,
    // Query values can contain accidentally supplied secrets. Keep only path.
    url: path,
    host: request.host,
    remoteAddress: request.remoteAddress,
    remotePort: request.remotePort,
  };
}

function safeErrorSerializer(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return { type: "UnknownError" };
  }

  const candidate = error as { name?: unknown; code?: unknown };
  return {
    type: typeof candidate.name === "string" ? candidate.name : "Error",
    code: typeof candidate.code === "string" ? candidate.code : undefined,
  };
}

export interface CreateAppLoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

export const LOG_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Keep detailed searches out of normal release logs. */
export function logDiscoveryEvent(
  logger: Pick<Logger, "debug" | "info" | "warn">,
  event: { code: string } & Record<string, unknown>,
): void {
  if (event.code === "DISCOVERY_FAILED") {
    logger.warn(event, "Discovery failed");
  } else if (event.code === "DISCOVERY_COMPLETED") {
    logger.info(event, "Discovery completed");
  } else {
    logger.debug(event, "Discovery trace");
  }
}

export function createAppLogger({
  level = "info",
  destination,
}: CreateAppLoggerOptions = {}): Logger {
  const options: LoggerOptions = {
    level,
    redact: {
      paths: [...LOG_REDACTION_PATHS],
      censor: "[REDACTED]",
    },
    serializers: {
      req: requestSerializer,
      err: safeErrorSerializer,
      error: safeErrorSerializer,
    },
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}
