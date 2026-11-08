import { afterEach, beforeEach, expect, it } from "vitest";
import { accounts, fixture } from "./helpers.js";
import { deviceToken, registeredHousehold } from "./household-helpers.js";
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.close());
it("keeps Master PIN management local and never accepts a cloud-global PIN", async () => {
  const before = f.sqlite
    .prepare("SELECT * FROM cloud_master_pin ORDER BY account_id")
    .all();
  const server = await deviceToken(f);
  for (const path of [
    "/v1/account/master-pin",
    "/v1/account/master-pin/enroll",
  ])
    for (const method of ["GET", "PUT"]) {
      expect(
        (
          await f.request(path, {
            method,
            account: "a",
            ...(method === "PUT" ? { data: { pin: "01234567" } } : {}),
          })
        ).status,
      ).toBe(410);
      expect(
        (
          await f.request(path, {
            method,
            token: server.token,
            ...(method === "PUT" ? { data: { pin: "01234567" } } : {}),
          })
        ).status,
      ).toBe(410);
    }
  expect(
    f.sqlite
      .prepare("SELECT * FROM cloud_master_pin ORDER BY account_id")
      .all(),
  ).toEqual(before);
});
it("approves and redeems server authorization without cloud Master PIN setup", async () => {
  f.sqlite
    .prepare(
      "UPDATE cloud_master_pin SET setup_required=1,verifier_json=NULL WHERE account_id=?",
    )
    .run(accounts.a!.id);
  const grant = (await (
    await f.request("/v1/device/code", {
      method: "POST",
      data: { client_id: "streamer-ai-home", device_name: "Server" },
    })
  ).json()) as { device_code: string; user_code: string };
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
  expect(
    f.sqlite
      .prepare("SELECT verifier_json FROM cloud_master_pin WHERE account_id=?")
      .get(accounts.a!.id),
  ).toEqual({ verifier_json: null });
});
it("approves local ownership recovery only for its household and initiating device, once", async () => {
  const one = await registeredHousehold(f),
    two = await registeredHousehold(f);
  const base = "/v1/households/" + one.householdId + "/pin-resets";
  const created = await f.request(base, {
    method: "POST",
    token: one.token,
    data: { purpose: "master-pin", profileName: "Household" },
  });
  expect(created.status).toBe(200);
  const { id } = (await created.json()) as { id: string };
  expect(
    (
      await f.request(base + "/" + id + "/decision", {
        method: "POST",
        account: "b",
        data: { approve: true },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(base + "/" + id + "/decision", {
        method: "POST",
        account: "a",
        authenticatedAt: f.now() - 300_001,
        data: { approve: true },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(base + "/" + id + "/decision", {
        method: "POST",
        account: "a",
        data: { approve: true },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.request(base + "/" + id + "/consume", {
        method: "POST",
        token: two.token,
        data: {},
      })
    ).status,
  ).toBe(403);
  expect(
    await (
      await f.request(base + "/" + id + "/consume", {
        method: "POST",
        token: one.token,
        data: {},
      })
    ).json(),
  ).toEqual({ status: "approved" });
  expect(
    await (
      await f.request(base + "/" + id + "/consume", {
        method: "POST",
        token: one.token,
        data: {},
      })
    ).json(),
  ).toEqual({ status: "expired" });
});
it("expires ownership approvals and hides revoked server requests", async () => {
  const one = await registeredHousehold(f);
  const base = "/v1/households/" + one.householdId + "/pin-resets";
  const { id } = (await (
    await f.request(base, {
      method: "POST",
      token: one.token,
      data: { purpose: "profile-pin", profileName: "Viewer" },
    })
  ).json()) as { id: string };
  f.sqlite
    .prepare("UPDATE cloud_device SET revoked_at=? WHERE id=?")
    .run(f.now(), one.deviceId);
  expect(await (await f.request(base, { account: "a" })).json()).toEqual({
    requests: [],
  });
  expect(
    (
      await f.request(base + "/" + id + "/consume", {
        method: "POST",
        token: one.token,
        data: {},
      })
    ).status,
  ).toBe(401);
  f.advance(301_000);
  expect(
    (
      await f.request(base + "/" + id + "/decision", {
        method: "POST",
        account: "a",
        data: { approve: true },
      })
    ).status,
  ).toBe(404);
});
