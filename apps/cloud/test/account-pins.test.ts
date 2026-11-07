import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { hash } from "../src/http.js";
import { accounts, fixture, masterPinVerifier } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  f.close();
});
async function device(account = "a", suffix = "a") {
  const token = suffix.charCodeAt(0).toString(16).repeat(32);
  f.sqlite
    .prepare(
      "INSERT INTO cloud_device (id, account_id, name, purpose, token_hash, created_at, expires_at) VALUES (?, ?, 'Home server', 'login', ?, ?, ?)",
    )
    .run(
      `device-${suffix}`,
      accounts[account]!.id,
      await hash(token),
      f.now(),
      f.now() + 300_000,
    );
  return token;
}
const putPin = (account = "a", extra: Record<string, unknown> = {}) =>
  f.request("/v1/account/master-pin", {
    method: "PUT",
    account,
    data: { verifier: masterPinVerifier() },
    ...extra,
  });

function changeableVerifier(pin: string) {
  const changeSalt = randomBytes(16).toString("hex");
  return {
    ...masterPinVerifier(pin),
    changeSalt,
    changeHash: pbkdf2Sync(pin, changeSalt, 600_000, 32, "sha256").toString(
      "hex",
    ),
  };
}

it("allows a paired server to change a PIN only with proof of the current PIN and the current version", async () => {
  const token = await device();
  const current = changeableVerifier("12345678");
  expect(
    (
      await f.request("/v1/account/master-pin", {
        method: "PUT",
        account: "a",
        data: { verifier: current },
      })
    ).status,
  ).toBe(200);
  const exposed = (await (
    await f.request("/v1/account/master-pin", { token })
  ).json()) as { verifier: Record<string, string> };
  expect(exposed.verifier.changeSalt).toBe(current.changeSalt);
  expect(exposed.verifier).not.toHaveProperty("changeHash");
  const next = changeableVerifier("87654321");
  const message = JSON.stringify([
    accounts.a!.id,
    current.version,
    next.version,
    next.salt,
    next.hash,
    next.changeSalt,
    next.changeHash,
  ]);
  const proof = createHmac("sha256", Buffer.from(current.changeHash, "hex"))
    .update(message)
    .digest("hex");
  const update = (data: unknown) =>
    f.request("/v1/account/master-pin", { method: "PUT", token, data });
  expect(
    (
      await update({
        verifier: next,
        expectedVersion: current.version,
        proof: "0".repeat(64),
      })
    ).status,
  ).toBe(403);
  expect(
    (await update({ verifier: next, expectedVersion: current.version, proof }))
      .status,
  ).toBe(200);
  expect(
    (await update({ verifier: next, expectedVersion: current.version, proof }))
      .status,
  ).toBe(409);
  const changed = (await (
    await f.request("/v1/account/master-pin", { token })
  ).json()) as { verifier: Record<string, string> };
  expect(changed.verifier.version).toBe(next.version);
  expect(changed.verifier).not.toHaveProperty("changeHash");
});

it("enrolls an existing PIN through a fresh browser session without changing it", async () => {
  const token = await device();
  const original = masterPinVerifier("12345678");
  await f.request("/v1/account/master-pin", {
    method: "PUT",
    account: "a",
    data: { verifier: original },
  });
  const path = "/v1/account/master-pin/enroll";
  expect((await f.request(path, { token })).status).toBe(403);
  expect(
    (
      await f.request(path, {
        account: "a",
        authenticatedAt: f.now() - 300_001,
      })
    ).status,
  ).toBe(403);
  const details = await (await f.request(path, { account: "a" })).json();
  expect(details).toEqual({
    required: true,
    salt: original.salt,
    version: original.version,
  });
  const changeSalt = randomBytes(16).toString("hex");
  const changeHash = pbkdf2Sync(
    "12345678",
    changeSalt,
    600_000,
    32,
    "sha256",
  ).toString("hex");
  const input = {
    version: original.version,
    proof: original.hash,
    changeSalt,
    changeHash,
  };
  expect(
    (
      await f.request(path, {
        method: "POST",
        account: "a",
        data: { ...input, proof: "0".repeat(64) },
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.request(path, { method: "POST", account: "a", data: input }))
      .status,
  ).toBe(200);
  const updated = (await (
    await f.request("/v1/account/master-pin", { token })
  ).json()) as { verifier: Record<string, string> };
  expect(updated.verifier).toMatchObject({
    hash: original.hash,
    version: original.version,
    changeSalt,
  });
  expect(updated.verifier).not.toHaveProperty("changeHash");
  expect(
    (await f.request(path, { method: "POST", account: "a", data: input }))
      .status,
  ).toBe(409);
});

it("requires a chosen Master PIN for a new online owner before approving a device", async () => {
  f.sqlite
    .prepare(
      'INSERT INTO "user" (id, email, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?)',
    )
    .run("new-owner", "new@example.test", "New owner", f.now(), f.now());
  expect(
    f.sqlite
      .prepare(
        "SELECT setup_required FROM cloud_master_pin WHERE account_id = 'new-owner'",
      )
      .get(),
  ).toEqual({ setup_required: 1 });
  // Use an existing session fixture to exercise the same setup gate.
  f.sqlite
    .prepare(
      "UPDATE cloud_master_pin SET setup_required = 1 WHERE account_id = ?",
    )
    .run(accounts.a!.id);
  expect(
    await (await f.request("/v1/account/master-pin", { account: "a" })).json(),
  ).toEqual({ setupRequired: true, initializationRequired: false });
  const grant = (await (
    await f.request("/v1/device/code", {
      method: "POST",
      data: { client_id: "streamer-ai-home", device_name: "TV" },
    })
  ).json()) as { user_code: string };
  const approve = () =>
    f.request("/v1/device/approve", {
      method: "POST",
      account: "a",
      data: { user_code: grant.user_code, approve: true },
    });
  expect((await approve()).status).toBe(409);
  expect((await putPin()).status).toBe(200);
  expect((await approve()).status).toBe(200);
});

it("stores only a salted verifier and supports reset only after fresh browser authentication", async () => {
  const token = await device();
  expect(
    (await putPin("a", { authenticatedAt: f.now() - 300_001 })).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/account/master-pin", {
        method: "PUT",
        token,
        data: { pin: "12345678", confirmation: "12345678" },
      })
    ).status,
  ).toBe(403);
  const validVerifier = masterPinVerifier();
  for (const verifier of [
    null,
    [],
    { ...validVerifier, salt: "short" },
    { ...validVerifier, hash: "not-a-hash" },
    { ...validVerifier, version: "not-a-uuid" },
  ]) {
    expect(
      (
        await f.request("/v1/account/master-pin", {
          method: "PUT",
          account: "a",
          data: { verifier },
        })
      ).status,
    ).toBe(400);
  }
  expect((await putPin()).status).toBe(200);
  const record = (await (
    await f.request("/v1/account/master-pin", { token })
  ).json()) as {
    accountId: string;
    verifier: { salt: string; hash: string; version: string };
  };
  expect(record.accountId).toBe(accounts.a!.id);
  expect(record.verifier.hash).toBe(
    pbkdf2Sync(
      "12345678",
      record.verifier.salt,
      600_000,
      32,
      "sha256",
    ).toString("hex"),
  );
  expect(
    JSON.stringify(f.sqlite.prepare("SELECT * FROM cloud_master_pin").all()),
  ).not.toContain("12345678");
  expect(
    await (await f.request("/v1/account/master-pin", { account: "a" })).json(),
  ).toEqual({ setupRequired: false, initializationRequired: false });
  await f.request("/v1/account/master-pin", {
    method: "PUT",
    account: "a",
    data: { verifier: masterPinVerifier("87654321") },
  });
  const changed = (await (
    await f.request("/v1/account/master-pin", { token })
  ).json()) as typeof record;
  expect(changed.verifier.version).not.toBe(record.verifier.version);
  expect(changed.verifier.hash).not.toBe(record.verifier.hash);
});

it("initializes a legacy verifier from the browser without invoking Workers PBKDF2 or replacing an existing PIN", async () => {
  f.sqlite
    .prepare(
      "UPDATE cloud_master_pin SET verifier_json = NULL WHERE account_id = ?",
    )
    .run(accounts.a!.id);
  const browserVerifier = masterPinVerifier("01234567");
  const derive = vi
    .spyOn(crypto.subtle, "deriveBits")
    .mockRejectedValue(
      new DOMException("Workers PBKDF2 iteration limit", "NotSupportedError"),
    );
  expect(
    await (await f.request("/v1/account/master-pin", { account: "a" })).json(),
  ).toEqual({ setupRequired: false, initializationRequired: true });
  const token = await device();
  expect((await f.request("/v1/account/master-pin", { token })).status).toBe(
    409,
  );
  const initialize = (verifier = browserVerifier) =>
    f.request("/v1/account/master-pin", {
      method: "PUT",
      account: "a",
      data: { initialize: true, verifier },
    });
  expect((await initialize()).status).toBe(200);
  expect((await initialize(masterPinVerifier("87654321"))).status).toBe(200);
  const first = await (
    await f.request("/v1/account/master-pin", { token })
  ).json();
  const second = await (
    await f.request("/v1/account/master-pin", { token })
  ).json();
  expect(second).toEqual(first);
  expect(first).not.toHaveProperty("pin");
  expect(first).toHaveProperty("verifier", browserVerifier);
  const grant = (await (
    await f.request("/v1/device/code", {
      method: "POST",
      data: { client_id: "streamer-ai-home", device_name: "TV" },
    })
  ).json()) as { user_code: string; device_code: string };
  expect(
    (
      await f.request("/v1/device/approve", {
        method: "POST",
        account: "a",
        data: { user_code: grant.user_code, approve: true },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.request("/v1/device/token", {
        method: "POST",
        data: {
          client_id: "streamer-ai-home",
          device_code: grant.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      })
    ).status,
  ).toBe(200);
  expect(derive).not.toHaveBeenCalled();
});

it("does not let legacy initialization bypass new-account setup or device authorization", async () => {
  const verifier = masterPinVerifier();
  const token = await device();
  f.sqlite
    .prepare(
      "UPDATE cloud_master_pin SET verifier_json = NULL, setup_required = 1 WHERE account_id = ?",
    )
    .run(accounts.a!.id);
  expect(
    (
      await f.request("/v1/account/master-pin", {
        method: "PUT",
        account: "a",
        data: { initialize: true, verifier },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.request("/v1/account/master-pin", {
        method: "PUT",
        token,
        data: { initialize: true, verifier },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/account/master-pin", {
        method: "PUT",
        account: "a",
        data: { pin: "12345678", confirmation: "12345678" },
      })
    ).status,
  ).toBe(400);
});

it("delivers recovery only to its owner and lets only the initiating device consume approval once", async () => {
  const token = await device(),
    other = await device("b", "b"),
    sameAccount = await device("a", "c");
  expect(
    (
      await f.request("/v1/account/pin-resets", {
        method: "POST",
        account: "a",
        data: { profileName: "Kids" },
      })
    ).status,
  ).toBe(403);
  const created = (await (
    await f.request("/v1/account/pin-resets", {
      method: "POST",
      token,
      data: { profileName: "Kids" },
    })
  ).json()) as { id: string };
  expect(
    await (await f.request("/v1/account/pin-resets", { account: "b" })).json(),
  ).toEqual({ requests: [] });
  const own = (await (
    await f.request("/v1/account/pin-resets", { account: "a" })
  ).json()) as { requests: { id: string; profile_name: string }[] };
  expect(own.requests).toMatchObject([
    { id: created.id, profile_name: "Kids" },
  ]);
  const decision = `/v1/account/pin-resets/${created.id}/decision`;
  expect(
    (
      await f.request(decision, {
        method: "POST",
        account: "b",
        data: { approve: true },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(decision, {
        method: "POST",
        account: "a",
        authenticatedAt: f.now() - 300_001,
        data: { approve: true },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(decision, {
        method: "POST",
        account: "a",
        data: { approve: true },
      })
    ).status,
  ).toBe(200);
  const consume = (bearer: string) =>
    f.request(`/v1/account/pin-resets/${created.id}/consume`, {
      method: "POST",
      token: bearer,
      data: {},
    });
  expect(await (await consume(other)).json()).toEqual({ status: "expired" });
  expect(await (await consume(sameAccount)).json()).toEqual({
    status: "expired",
  });
  expect(await (await consume(token)).json()).toEqual({ status: "approved" });
  expect(await (await consume(token)).json()).toEqual({ status: "expired" });
});

it("rejects expired recovery and excludes revoked devices from pending approvals", async () => {
  const token = await device();
  const created = (await (
    await f.request("/v1/account/pin-resets", {
      method: "POST",
      token,
      data: { profileName: "Kids" },
    })
  ).json()) as { id: string };
  f.sqlite.prepare("UPDATE cloud_device SET revoked_at = ?").run(f.now());
  expect(
    await (await f.request("/v1/account/pin-resets", { account: "a" })).json(),
  ).toEqual({ requests: [] });
  expect(
    (
      await f.request(`/v1/account/pin-resets/${created.id}/consume`, {
        method: "POST",
        token,
        data: {},
      })
    ).status,
  ).toBe(401);
  f.advance(300_001);
  expect(
    (
      await f.request(`/v1/account/pin-resets/${created.id}/decision`, {
        method: "POST",
        account: "a",
        data: { approve: true },
      })
    ).status,
  ).toBe(404);
});
