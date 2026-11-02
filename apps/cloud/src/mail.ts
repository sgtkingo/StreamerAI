import type { Env } from "./types.js";
import { HttpError } from "./http.js";

export function mailConfigured(env: Env): boolean {
  return !!(env.BREVO_API_KEY && env.MAIL_FROM);
}

/** Codes and provider responses must never enter logs or browser error messages. */
export async function sendLoginCode(
  env: Env,
  email: string,
  code: string,
  purpose: "sign-in" | "email-verification" = "sign-in",
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!mailConfigured(env)) throw new HttpError(503, "email_unavailable");
  try {
    const activation = purpose === "email-verification";
    const issuedAt = new Intl.DateTimeFormat("cs-CZ", {
      timeZone: "Europe/Prague",
      dateStyle: "short",
      timeStyle: "medium",
    }).format(new Date());
    const response = await fetcher("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY!,
        "content-type": "application/json",
        accept: "application/json",
      },
      // Workers rejects redirect:"error" before opening the connection.
      // Manual mode keeps the API key on this host; non-2xx is rejected below.
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM, name: "StreamerAI" },
        to: [{ email }],
        // A different subject per request keeps newer codes out of old threads.
        // The OTP itself stays in the body, outside the subject.
        subject: `StreamerAI — ${activation ? "aktivace e-mailu" : "přihlašovací kód"} (${issuedAt})`,
        textContent: `Váš jednorázový kód pro ${activation ? "aktivaci přihlášení e-mailem" : "přihlášení"} ke StreamerAI: ${code}\n\nKód platí 10 minut. Použijte nejnovější kód pro tuto akci. Nikomu jej nesdělujte. Pokud jste o tuto akci nepožádali, zprávu ignorujte.`,
      }),
    });
    if (!response.ok) {
      let code = "unknown";
      let reason = "other";
      try {
        const detail = (await response.json()) as {
          code?: unknown;
          message?: unknown;
        };
        if (
          typeof detail.code === "string" &&
          new Set([
            "invalid_parameter",
            "missing_parameter",
            "unauthorized",
            "permission_denied",
            "not_enough_credits",
            "account_under_validation",
            "bad_request",
            "method_not_allowed",
            "too_many_requests",
            "document_not_found",
            "duplicate_parameter",
          ]).has(detail.code)
        )
          code = detail.code;
        const message =
          typeof detail.message === "string"
            ? detail.message.toLowerCase()
            : "";
        if (/\bip\b|ip address/.test(message)) reason = "ip_restriction";
        else if (/api.?key|credential/.test(message)) reason = "credentials";
        else if (/sender|sending domain/.test(message)) reason = "sender";
        else if (/credit|quota/.test(message)) reason = "quota";
        else if (/account|activat|suspend/.test(message)) reason = "account";
      } catch {
        /* Provider bodies never enter logs. */
      }
      console.warn("mail_rejected", { status: response.status, code, reason });
      throw new Error("Mail transport rejected the request.");
    }
    await response.body?.cancel();
  } catch {
    throw new HttpError(503, "email_unavailable");
  }
}
