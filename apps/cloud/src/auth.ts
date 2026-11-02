import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";

import { HttpError, rateLimit } from "./http.js";
import type { Env, SessionReader } from "./types.js";
import { mailConfigured, sendLoginCode } from "./mail.js";

export function createAuth(env: Env): SessionReader {
  // D1 work and initialization promises belong to the current Worker request.
  // Reusing an instance can strand later requests when its creator disconnects.
  // Better Auth deliberately absorbs background mail errors. Propagate a neutral
  // failure for this request so callers never display a false delivery success.
  const mailFailures = new WeakSet<Request>();
  const instantiate = () =>
    betterAuth({
      appName: "StreamerAI",
      baseURL: env.AUTH_ORIGIN,
      basePath: "/api/auth",
      secret: env.BETTER_AUTH_SECRET,
      database: env.DB,
      trustedOrigins: [env.AUTH_ORIGIN],
      emailAndPassword: { enabled: false },
      plugins: mailConfigured(env)
        ? [
            emailOTP({
              otpLength: 8,
              expiresIn: 600,
              allowedAttempts: 5,
              rateLimit: { window: 60, max: 10 },
              storeOTP: {
                hash: async (otp) => {
                  const key = await crypto.subtle.importKey(
                    "raw",
                    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
                    { name: "HMAC", hash: "SHA-256" },
                    false,
                    ["sign"],
                  );
                  const value = await crypto.subtle.sign(
                    "HMAC",
                    key,
                    new TextEncoder().encode(otp),
                  );
                  return Array.from(new Uint8Array(value), (b) =>
                    b.toString(16).padStart(2, "0"),
                  ).join("");
                },
              },
              sendVerificationOTP: async ({ email, otp, type }, ctx) => {
                try {
                  if (type !== "sign-in" && type !== "email-verification")
                    throw new HttpError(503, "email_unavailable");
                  await sendLoginCode(env, email, otp, type);
                } catch {
                  if (ctx?.request) mailFailures.add(ctx.request);
                }
              },
            }),
          ]
        : [],
      socialProviders: {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          prompt: "select_account",
          accessType: "online",
        },
      },
      account: {
        accountLinking: { enabled: true, disableImplicitLinking: true },
        encryptOAuthTokens: true,
      },
      session: {
        expiresIn: 60 * 60 * 24 * 7,
        updateAge: 60 * 60 * 24,
        cookieCache: { enabled: false },
      },
      advanced: {
        cookiePrefix: "streamer-ai",
        useSecureCookies: env.AUTH_ORIGIN.startsWith("https:"),
        ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      },
      rateLimit: {
        enabled: true,
        window: 60,
        max: 30,
        customStorage: {
          consume: async (key, rule) => {
            const result = await rateLimit(
              env.DB,
              `auth:${key}`,
              rule.max,
              rule.window,
              Date.now(),
            );
            return {
              allowed: result.allowed,
              retryAfter: result.allowed ? null : result.retryAfter,
            };
          },
        },
      },
      logger: { disabled: true },
    });
  // Bearer-only device requests never need to initialize browser auth or inspect
  // its database schema. Keep both work and pending promises inside this request.
  let auth: ReturnType<typeof instantiate> | undefined;
  const current = () => (auth ??= instantiate());
  const reader: SessionReader = {
    handler: async (request) => {
      const response = await bounded(current().handler(request), "handler");
      if (mailFailures.has(request))
        return Response.json({ error: "email_unavailable" }, { status: 503 });
      return response;
    },
    getSession: async (request) => {
      const session = await bounded(
        current().api.getSession({ headers: request.headers }),
        "session",
      );
      return session
        ? {
            id: session.user.id,
            email: session.user.email,
            name: session.user.name,
            authenticatedAt: session.session.createdAt.getTime(),
          }
        : null;
    },
  };
  return reader;
}

async function bounded<T>(pending: Promise<T>, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          console.warn("auth_timeout", { operation });
          reject(new HttpError(503, "auth_unavailable"));
        }, 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
