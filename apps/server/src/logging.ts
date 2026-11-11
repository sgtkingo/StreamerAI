import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

export const LOG_REDACTION_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["x-streamer-internal-token"]',
  'res.headers["set-cookie"]',
  "authorization",
  "token",
  "accessToken",
  "readAccessToken",
  "apiKey",
  "api_key",
  "password",
  "pin",
  "masterPin",
  "currentPin",
  "newPin",
  "confirmation",
  "wst",
  "body.authorization",
  "body.token",
  "body.accessToken",
  "body.readAccessToken",
  "body.apiKey",
  "body.password",
  "body.pin",
  "body.masterPin",
  "body.currentPin",
  "body.newPin",
  "body.confirmation",
  "body.wst",
  "credentials.*",
] as const;

const REDACTED = "[REDACTED]";
const errorTypes = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
]);
const errorCodes = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EADDRINUSE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "ABORT_ERR",
  "SQLITE_BUSY",
  "SQLITE_ERROR",
]);

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized === "body" ||
    normalized === "payload" ||
    normalized === "query" ||
    normalized === "querystring" ||
    normalized === "searchparams" ||
    normalized === "headers" ||
    normalized === "confirmation" ||
    normalized === "otp" ||
    normalized === "pwd" ||
    normalized === "pass" ||
    normalized === "passcode" ||
    normalized === "wst" ||
    normalized === "proof" ||
    normalized === "authorization" ||
    normalized === "auth" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "tokens" ||
    normalized === "recoverykey" ||
    normalized === "backupkey" ||
    normalized === "devicecode" ||
    normalized === "usercode" ||
    normalized === "verificationcode" ||
    normalized === "pairingcode" ||
    normalized === "url" ||
    normalized === "uri" ||
    normalized === "href" ||
    normalized.endsWith("key") ||
    normalized.includes("verifier") ||
    /^pin(?:hash|code|value|confirmation)/.test(normalized) ||
    normalized.includes("password") ||
    normalized.includes("passphrase") ||
    normalized.includes("masterpin") ||
    normalized.endsWith("pin") ||
    normalized.endsWith("pinhash") ||
    normalized.endsWith("pincode") ||
    normalized.endsWith("token") ||
    normalized.includes("secret") ||
    normalized.includes("credential")
  );
}

function requestSerializer(request: Record<string, unknown>) {
  if (!request || typeof request !== "object") return {};
  const route = request.routeOptions;
  const template =
    route && typeof route === "object" && "url" in route
      ? route.url
      : undefined;
  const rawUrl =
    typeof template === "string"
      ? template
      : typeof request.url === "string"
        ? request.url
        : undefined;
  const path = rawUrl
    ?.split(/[?#]/, 1)[0]
    ?.replace(/(\/api\/v1\/playback\/grants\/)[^/]+/g, "$1[REDACTED]");

  return {
    id: request.id,
    method: request.method,
    // Query values can contain accidentally supplied secrets. Keep only path.
    url: path,
    host: safeHost(request.host),
    remoteAddress: request.remoteAddress,
    remotePort: request.remotePort,
  };
}

function safeHost(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 255) return undefined;
  try {
    const url = new URL(`http://${value}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.host;
  } catch {
    return undefined;
  }
}

function safeErrorSerializer(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return { type: "UnknownError" };
  }

  try {
    const candidate = error as {
      name?: unknown;
      type?: unknown;
      code?: unknown;
    };
    const type = candidate.name ?? candidate.type;
    return {
      type: typeof type === "string" && errorTypes.has(type) ? type : "Error",
      code:
        typeof candidate.code === "string" && errorCodes.has(candidate.code)
          ? candidate.code
          : undefined,
    };
  } catch {
    return { type: "Error" };
  }
}

/** Copy structured records before logging so sensitive values at any depth never reach Pino. */
function sanitizeRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (value instanceof Error) return safeErrorSerializer(value);
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date)
      return Number.isFinite(value.getTime())
        ? value.toISOString()
        : "[INVALID DATE]";
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
      return REDACTED;
    if (depth >= 12) return "[TRUNCATED]";
    if (ancestors.has(value)) return "[Circular]";
    ancestors.add(value);
    try {
      if (Array.isArray(value))
        return value.map((item) => visit(item, depth + 1));
      const result: Record<string, unknown> = {};
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(value),
      )) {
        if (!descriptor.enumerable) continue;
        let sanitized: unknown;
        if (depth === 0 && key === "req")
          sanitized =
            "value" in descriptor
              ? requestSerializer(descriptor.value as Record<string, unknown>)
              : undefined;
        else if (sensitiveKey(key) || !("value" in descriptor))
          sanitized = REDACTED;
        else if (["err", "error", "cause"].includes(key.toLowerCase()))
          sanitized = safeErrorSerializer(descriptor.value);
        else sanitized = visit(descriptor.value, depth + 1);
        Object.defineProperty(result, key, {
          value: sanitized,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(record, 0) as Record<string, unknown>;
}

/** Pino resets the bindings formatter on child loggers, so sanitize before it serializes bindings. */
function protectBindings(logger: Logger): void {
  const child = logger.child;
  const setBindings = logger.setBindings;
  logger.child = function (this: Logger, ...args: Parameters<Logger["child"]>) {
    return Reflect.apply(child, this, [sanitizeRecord(args[0]), args[1]]);
  } as Logger["child"];
  logger.setBindings = function (bindings) {
    return setBindings.call(this, sanitizeRecord(bindings));
  };
}

const SHAREABLE_LOG_CODES = new Set([
  "DISCOVERY_FAILED",
  "DISCOVERY_COMPLETED",
  "UNHANDLED_REQUEST_ERROR",
  "PLAYBACK_MANIFEST_READY",
  "PLAYBACK_MANIFEST_FAILED",
  "PLAYBACK_STREAM_STARTED",
  "PLAYBACK_STREAM_FINISHED",
  "PLAYBACK_STREAM_FAILED",
  "PLAYBACK_STREAM_SETUP_FAILED",
  "PLAYBACK_STREAM_MONITOR_FAILED",
  "PLAYBACK_THUMBNAIL_FAILED",
  "PLAYBACK_SUBTITLE_WINDOW_FAILED",
  "PLAYBACK_SUBTITLE_PROVIDER_FAILED",
  "PLAYBACK_EXTERNAL_SUBTITLE_DISCOVERY_FAILED",
  "ACCOUNT_SYNC_CAPTURE_PENDING",
  "ACCOUNT_DELETION_CHECK_FAILED",
  "LAN_DISCOVERY_UNAVAILABLE",
  "VOLATILE_PLAINTEXT_SECRET_STORAGE",
]);

/** Keep only explicitly classified events, never arbitrary messages, identifiers or paths. */
export function createDiagnosticLogBuffer() {
  const events: Array<{ time: string; level: number; code: string }> = [];
  return {
    capture(chunk: string) {
      for (const line of chunk.split("\n")) {
        if (!line) continue;
        try {
          const record: unknown = JSON.parse(line);
          if (!record || typeof record !== "object") continue;
          const { time, level, code } = record as Record<string, unknown>;
          if (
            typeof code !== "string" ||
            !SHAREABLE_LOG_CODES.has(code) ||
            typeof time !== "number" ||
            !Number.isFinite(time) ||
            typeof level !== "number"
          )
            continue;
          const date = new Date(time);
          if (!Number.isFinite(date.getTime())) continue;
          events.push({ time: date.toISOString(), level, code });
          if (events.length > 100) events.shift();
        } catch {
          /* Ignore incomplete or non-JSON log output. */
        }
      }
    },
    snapshot() {
      return events.slice();
    },
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
      cause: safeErrorSerializer,
    },
    formatters: { log: sanitizeRecord, bindings: sanitizeRecord },
    hooks: {
      logMethod(args, method) {
        const first = args[0];
        if (
          args[1] === undefined &&
          first &&
          typeof first === "object" &&
          (first instanceof Error ||
            ("err" in first && first.err && !("msg" in first)))
        )
          return method.apply(this, [first, "Error"]);
        return method.apply(this, args);
      },
    },
    onChild: protectBindings,
  };

  const logger =
    destination === undefined ? pino(options) : pino(options, destination);
  protectBindings(logger);
  return logger;
}
