import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_PLAYBACK_PREFERENCES,
} from "@streamer-ai/contracts";
import {
  approvalSignature,
  type ApprovalIntent,
  type ApprovalKind,
} from "../src/approval-mail.js";
import { accounts, fixture, origin } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
  f.sqlite
    .prepare('UPDATE "user" SET "emailVerified" = 1 WHERE id = ?')
    .run(accounts.b!.id);
});
afterEach(() => f.close());

function profile(id: string) {
  const { audioOutputDeviceId: _ignored, ...playback } =
    DEFAULT_PLAYBACK_PREFERENCES;
  return {
    id: crypto.randomUUID(),
    kind: "profile",
    action: "upsert",
    profileId: id,
    entityId: id,
    updatedAt: new Date(f.now()).toISOString(),
    payload: {
      name: id,
      locale: "cs",
      genres: [],
      playback,
      appearance: DEFAULT_APPEARANCE_PREFERENCES,
      onboardingComplete: true,
    },
  };
}
async function push(account: string, ids: string[]) {
  expect(
    (
      await f.request("/v1/sync/push", {
        method: "POST",
        account,
        data: { operations: ids.map(profile) },
      })
    ).status,
  ).toBe(200);
}
async function link(kind: ApprovalKind, id: string, intent: ApprovalIntent) {
  const token = await approvalSignature(f.env, {
    kind,
    requestId: id,
    intent,
    targetAccountId: accounts.b!.id,
    email: accounts.b!.email,
  });
  const url = new URL("/email-approval", origin);
  url.searchParams.set("kind", kind);
  url.searchParams.set("id", id);
  url.searchParams.set("intent", intent);
  url.searchParams.set("token", token);
  return url;
}
async function transfer() {
  await push("a", ["profile-source"]);
  const created = await f.request("/v1/transfers", {
    method: "POST",
    account: "a",
    data: { profileId: "profile-source", target: accounts.b!.id },
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

it("accepts a transfer from the signed email link without a session, and rejects replay or a changed decision", async () => {
  const id = await transfer();
  const url = await link("transfer", id, "accept");
  const tampered = new URL(url);
  tampered.searchParams.set("intent", "decline");
  expect((await f.request(tampered.pathname + tampered.search)).status).toBe(
    404,
  );
  expect((await f.request(url.pathname + url.search)).status).toBe(200);
  expect(
    f.sqlite
      .prepare("SELECT account_id FROM cloud_profile WHERE id = ?")
      .get("profile-source"),
  ).toEqual({ account_id: accounts.b!.id });
  expect((await f.request(url.pathname + url.search)).status).toBe(404);
});

it("declines without a session and rejects expired or wrong-recipient links", async () => {
  const id = await transfer();
  const url = await link("transfer", id, "decline");
  f.sqlite
    .prepare('UPDATE "user" SET email = ? WHERE id = ?')
    .run("changed@example.test", accounts.b!.id);
  expect((await f.request(url.pathname + url.search)).status).toBe(404);
  f.sqlite
    .prepare('UPDATE "user" SET email = ? WHERE id = ?')
    .run(accounts.b!.email, accounts.b!.id);
  expect((await f.request(url.pathname + url.search)).status).toBe(200);
  expect(
    f.sqlite
      .prepare("SELECT account_id FROM cloud_profile WHERE id = ?")
      .get("profile-source"),
  ).toEqual({ account_id: accounts.a!.id });
  expect((await f.request(url.pathname + url.search)).status).toBe(404);
  const again = await f.request("/v1/transfers", {
    method: "POST",
    account: "a",
    data: { profileId: "profile-source", target: accounts.b!.id },
  });
  const expired = await link(
    "transfer",
    ((await again.json()) as { id: string }).id,
    "accept",
  );
  f.advance(86_400_001);
  expect((await f.request(expired.pathname + expired.search)).status).toBe(404);
});

it("asks for the profile selection without logging in when the target is full", async () => {
  const ids = ["target-1", "target-2", "target-3", "target-4", "target-5"];
  await push("b", ids);
  const id = await transfer();
  const url = await link("transfer", id, "accept");
  const review = await f.request(url.pathname + url.search);
  expect(await review.text()).toContain("Vyberte profily");
  expect(
    f.sqlite
      .prepare("SELECT account_id FROM cloud_profile WHERE id = ?")
      .get("profile-source"),
  ).toEqual({ account_id: accounts.a!.id });
  const form = new URLSearchParams();
  ids.forEach((value) => form.append("seen", value));
  ids.slice(0, 4).forEach((value) => form.append("keep", value));
  const foreign = await f.worker.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        origin: "https://elsewhere.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }),
    f.env,
  );
  expect(foreign.status).toBe(403);
  const stale = new URLSearchParams(form);
  stale.delete("seen");
  ids.slice(0, 4).forEach((value) => stale.append("seen", value));
  const rejected = await f.worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: stale.toString(),
    }),
    f.env,
  );
  expect(rejected.status).toBe(409);
  const accepted = await f.worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    f.env,
  );
  expect(accepted.status).toBe(200);
  expect(
    f.sqlite
      .prepare("SELECT account_id FROM cloud_profile WHERE id = ?")
      .get("profile-source"),
  ).toEqual({ account_id: accounts.b!.id });
  expect(
    f.sqlite
      .prepare("SELECT active FROM cloud_profile WHERE id = ?")
      .get("target-5"),
  ).toEqual({ active: 0 });
});

it("requires selection for a merge over five profiles, while keeping email access sufficient", async () => {
  const source = ["a1", "a2", "a3"];
  const target = ["b1", "b2", "b3"];
  await push("a", source);
  await push("b", target);
  f.sqlite
    .prepare(
      "INSERT INTO cloud_email_login (user_id, enabled_at) VALUES (?, ?)",
    )
    .run(accounts.b!.id, f.now());
  f.sqlite
    .prepare(
      "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("google-a", "google-sub", "google", accounts.a!.id, f.now(), f.now());
  const created = await f.request("/v1/merges", {
    method: "POST",
    account: "a",
    data: { target: accounts.b!.id },
  });
  const url = await link(
    "merge",
    ((await created.json()) as { id: string }).id,
    "accept",
  );
  expect(await (await f.request(url.pathname + url.search)).text()).toContain(
    "Vyberte profily",
  );
  const form = new URLSearchParams();
  [...source, ...target].forEach((value) => form.append("seen", value));
  ["a1", "a2", ...target].forEach((value) => form.append("keep", value));
  const accepted = await f.worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    f.env,
  );
  expect(accepted.status).toBe(200);
  expect(
    f.sqlite
      .prepare(
        "SELECT COUNT(*) AS total FROM cloud_profile WHERE account_id = ? AND active = 1",
      )
      .get(accounts.b!.id),
  ).toEqual({ total: 5 });
  expect(
    f.sqlite.prepare("SELECT active FROM cloud_profile WHERE id = ?").get("a3"),
  ).toEqual({ active: 0 });
});

it("merges an email and Google account directly from the recipient link", async () => {
  await push("a", ["profile-a"]);
  await push("b", ["profile-b"]);
  f.sqlite
    .prepare(
      "INSERT INTO cloud_email_login (user_id, enabled_at) VALUES (?, ?)",
    )
    .run(accounts.b!.id, f.now());
  f.sqlite
    .prepare(
      "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("google-a", "google-sub", "google", accounts.a!.id, f.now(), f.now());
  const created = await f.request("/v1/merges", {
    method: "POST",
    account: "a",
    data: { target: accounts.b!.id },
  });
  expect(created.status).toBe(201);
  const url = await link(
    "merge",
    ((await created.json()) as { id: string }).id,
    "accept",
  );
  expect((await f.request(url.pathname + url.search)).status).toBe(200);
  expect(
    f.sqlite.prepare("SELECT userId FROM account WHERE id = ?").get("google-a"),
  ).toEqual({ userId: accounts.b!.id });
  expect(
    f.sqlite
      .prepare("SELECT account_id FROM cloud_profile WHERE id = ?")
      .get("profile-a"),
  ).toEqual({ account_id: accounts.b!.id });
  expect((await f.request(url.pathname + url.search)).status).toBe(404);
});
