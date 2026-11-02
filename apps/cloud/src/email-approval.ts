import {
  approvalSignature,
  type ApprovalIntent,
  type ApprovalKind,
} from "./approval-mail.js";
import { enforceRateLimit, HttpError, sameOrigin } from "./http.js";
import { decideMerge } from "./merges.js";
import { acceptTransfer, declineTransfer } from "./transfers.js";
import type { Env, Principal } from "./types.js";

interface Pending {
  approver_id: string;
  source_account_id: string;
  target_account_id: string;
  profile_id?: string;
  email: string;
  name: string;
}
interface Profile {
  id: string;
  account_id: string;
  operation_json: string;
}

async function selectionForm(request: Request): Promise<URLSearchParams> {
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new HttpError(415, "invalid_form");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_form");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 16_384) {
      await reader.cancel();
      throw new HttpError(413, "form_too_large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.length;
  }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}
function html(title: string, content: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} — StreamerAI</title><link rel="stylesheet" href="/assets/auth.css"></head><body><main><div class="brand">STREAMER AI</div><h1>${escape(title)}</h1>${content}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

export function emailApprovalError(error: HttpError): Response {
  const detail =
    error.status === 429
      ? "Příliš mnoho pokusů. Počkejte a zkuste to znovu."
      : error.status === 409
        ? "Účty nebo profily se mezitím změnily. Otevřete odkaz znovu nebo požádejte o novou žádost."
        : "Odkaz není platný, žádost vypršela nebo už byla vyřízena.";
  return html("Žádost není dostupná", `<p>${detail}</p>`, error.status);
}

/** The signed email URL grants only its specific decision; it never creates a login session. */
export async function emailApproval(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") as ApprovalKind | null;
  const intent = url.searchParams.get("intent") as ApprovalIntent | null;
  const id = url.searchParams.get("id") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (
    !(["transfer", "merge"] as unknown[]).includes(kind) ||
    !(["accept", "decline"] as unknown[]).includes(intent) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      id,
    ) ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw new HttpError(404, "approval_not_found");
  await enforceRateLimit(
    env.DB,
    `email-approval:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    100,
    600,
    now,
  );
  const pending = await env.DB.prepare(
    kind === "merge"
      ? `SELECT m.approver_id, m.source_account_id, m.target_account_id, u.email, u.name FROM cloud_account_merge m JOIN "user" u ON u.id = m.approver_id WHERE m.id = ? AND m.accepted_at IS NULL AND m.expires_at > ? AND u."emailVerified" = 1`
      : `SELECT t.target_account_id AS approver_id, t.source_account_id, t.target_account_id, t.profile_id, u.email, u.name FROM cloud_transfer t JOIN "user" u ON u.id = t.target_account_id WHERE t.id = ? AND t.accepted_at IS NULL AND t.expires_at > ? AND u."emailVerified" = 1`,
  )
    .bind(id, now)
    .first<Pending>();
  if (!pending) throw new HttpError(404, "approval_not_found");
  const expected = await approvalSignature(env, {
    kind: kind!,
    intent: intent!,
    requestId: id,
    targetAccountId: pending.approver_id,
    email: pending.email,
  });
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  if (difference !== 0) throw new HttpError(404, "approval_not_found");
  const principal: Principal = {
    method: "browser",
    account: {
      id: pending.approver_id,
      email: pending.email,
      name: pending.name,
    },
    authenticatedAt: now,
  };
  const internal = (path: string, data: unknown) =>
    new Request(new URL(path, env.AUTH_ORIGIN), {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.AUTH_ORIGIN },
      body: JSON.stringify(data),
    });
  if (intent === "decline") {
    if (request.method !== "GET")
      throw new HttpError(405, "method_not_allowed");
    if (kind === "merge")
      await decideMerge(
        internal(`/v1/merges/${id}/decision`, { approve: false }),
        env,
        principal,
        id,
        now,
      );
    else
      await declineTransfer(
        internal(`/v1/transfers/${id}/decline`, {}),
        env,
        principal,
        id,
        now,
      );
    return html(
      "Žádost byla zamítnuta",
      "<p>Účty a profily zůstaly beze změny.</p>",
    );
  }
  const accountIds =
    kind === "merge"
      ? [pending.source_account_id, pending.target_account_id]
      : [pending.target_account_id];
  const profiles = await env.DB.prepare(
    `SELECT p.id, p.account_id, e.operation_json FROM cloud_profile p JOIN cloud_entity e ON e.profile_id = p.id AND e.account_id = p.account_id AND e.kind = 'profile' AND e.action = 'upsert' WHERE p.active = 1 AND p.account_id IN (${accountIds.map(() => "?").join(",")}) ORDER BY p.account_id, p.id`,
  )
    .bind(...accountIds)
    .all<Profile>();
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM cloud_profile WHERE active = 1 AND account_id IN (${accountIds.map(() => "?").join(",")})`,
  )
    .bind(...accountIds)
    .first<{ total: number }>();
  if (Number(count?.total) !== profiles.results.length)
    throw new HttpError(409, "approval_changed");
  const requiresSelection =
    profiles.results.length + (kind === "transfer" ? 1 : 0) > 5;
  let keep = profiles.results.map((p) => p.id);
  let seen = keep;
  if (request.method === "POST") {
    sameOrigin(request, env.AUTH_ORIGIN);
    const data = await selectionForm(request);
    keep = data.getAll("keep");
    seen = data.getAll("seen");
    if (
      seen.length !== profiles.results.length ||
      new Set(seen).size !== seen.length ||
      profiles.results.some((p) => !seen.includes(p.id)) ||
      keep.some((value) => !seen.includes(value)) ||
      new Set(keep).size !== keep.length ||
      keep.length + (kind === "transfer" ? 1 : 0) > 5 ||
      (profiles.results.length > 0 && !keep.length && kind === "merge")
    )
      return html(
        "Zkontrolujte výběr",
        "<p>Seznam profilů se změnil nebo překračuje limit pěti. Otevřete odkaz z e-mailu znovu a vyberte profily.</p>",
        409,
      );
  } else if (request.method !== "GET")
    throw new HttpError(405, "method_not_allowed");
  if (request.method === "GET" && requiresSelection) {
    const options = profiles.results
      .map((p) => {
        const parsed = JSON.parse(p.operation_json) as {
          payload: { name: string };
        };
        const owner =
          p.account_id === pending.target_account_id
            ? "Cílový účet"
            : "Druhý účet";
        return `<label><input type="checkbox" name="keep" value="${escape(p.id)}" checked> ${escape(parsed.payload.name)} · ${owner}</label><input type="hidden" name="seen" value="${escape(p.id)}">`;
      })
      .join("");
    let incoming = "";
    if (kind === "transfer") {
      const row = await env.DB.prepare(
        `SELECT e.operation_json FROM cloud_entity e JOIN cloud_profile p ON p.id = e.profile_id AND p.account_id = e.account_id WHERE p.id = ? AND p.account_id = ? AND p.active = 1 AND e.kind = 'profile' AND e.action = 'upsert'`,
      )
        .bind(pending.profile_id, pending.source_account_id)
        .first<{ operation_json: string }>();
      if (!row) throw new HttpError(404, "approval_not_found");
      const name = (
        JSON.parse(row.operation_json) as { payload: { name: string } }
      ).payload.name;
      incoming = `<p>Přijímaný profil: <strong>${escape(name)}</strong></p>`;
    }
    const intro =
      kind === "transfer"
        ? "Přijímaný profil se zachová. Z ostatních vyberte nejvýše čtyři."
        : "Vyberte nejvýše pět profilů, které zůstanou zachovány.";
    return html(
      "Vyberte profily",
      `<p>${intro} Nevybrané profily budou smazány z cloudu i synchronizovaných instalací.</p>${incoming}<section><form class="email-approval__profiles" method="post" action="${escape(url.pathname + url.search)}">${options}<button type="submit">Potvrdit výběr a přijmout</button></form></section>`,
    );
  }
  if (kind === "merge")
    await decideMerge(
      internal(`/v1/merges/${id}/decision`, {
        approve: true,
        profileIds: keep,
        expectedProfileIds: seen,
      }),
      env,
      principal,
      id,
      now,
    );
  else
    await acceptTransfer(
      internal(`/v1/transfers/${id}/accept`, {
        removeProfileIds: profiles.results
          .filter((p) => !keep.includes(p.id))
          .map((p) => p.id),
      }),
      env,
      principal,
      id,
      now,
    );
  return html(
    "Žádost byla přijata",
    "<p>Změna byla dokončena. Profily se projeví po synchronizaci domácích instalací.</p>",
  );
}
