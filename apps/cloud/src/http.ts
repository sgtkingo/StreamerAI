export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function body(
  request: Pick<Request, "headers" | "body">,
  limit = 524_288,
): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new HttpError(415, "json_required");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_json");
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > limit) {
      await reader.cancel();
      throw new HttpError(413, "body_too_large");
    }
    parts.push(chunk.value);
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request");
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new HttpError(400, "invalid_request");
  }
  return value.trim();
}

export function sameOrigin(request: Request, origin: string): void {
  if (request.headers.get("origin") !== origin) {
    throw new HttpError(403, "origin_required");
  }
}

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function normalizeCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export async function rateLimit(
  db: D1Database,
  key: string,
  max: number,
  windowSeconds: number,
  now: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const window = Math.floor(now / (windowSeconds * 1000));
  const bucket = await hash(`${key}:${windowSeconds}:${window}`);
  const row = await db
    .prepare(
      `
    INSERT INTO cloud_rate_limit (id, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET hits = hits + 1 RETURNING hits
  `,
    )
    .bind(bucket, (window + 1) * windowSeconds * 1000)
    .first<{ hits: number }>();
  return {
    allowed: (row?.hits ?? max + 1) <= max,
    retryAfter: Math.ceil(((window + 1) * windowSeconds * 1000 - now) / 1000),
  };
}

export async function enforceRateLimit(
  db: D1Database,
  key: string,
  max: number,
  seconds: number,
  now: number,
): Promise<void> {
  const result = await rateLimit(db, key, max, seconds, now);
  if (!result.allowed) {
    throw new HttpError(429, "rate_limited", result.retryAfter);
  }
}
