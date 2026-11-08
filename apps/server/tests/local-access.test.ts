import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import { LocalAccessService } from "../src/services/local-access.js";

const fixtures: {
  app: FastifyInstance;
  db: StreamerDatabase;
  directory: string;
}[] = [];
afterEach(async () => {
  for (const { app, db, directory } of fixtures.splice(0)) {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;
function fixture() {
  let time = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "streamerai-access-test-"));
  const db = openStreamerDatabase({ filename: ":memory:" });
  const app = Fastify();
  const access = new LocalAccessService(db, {
    enabled: true,
    dataDirectory: directory,
    origin: "http://localhost",
    verifyMasterPin: async (pin) => pin === "01234567",
    householdStatus: async () => ({
      householdReady: true,
      householdName: "Test home",
      masterPinEnabled: true,
      cloudConfigured: false,
    }),
    now: () => new Date(time),
  });
  access.register(app);
  app.get("/api/v1/private", async () => ({ secret: "household" }));
  fixtures.push({ app, db, directory });
  return {
    app,
    access,
    db,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
describe("installation access", () => {
  it("keeps client identity and access while cloud management is attached or detached", async () => {
    const { app, access, db } = fixture();
    db.accounts.upsert({ id: "household-main", name: "Home" });
    db.settings.set(
      "household.id.household-main",
      "11111111-1111-4111-8111-111111111111",
    );
    access.bindHousehold("household-main");
    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/installation/authorize",
      payload: { masterPin: "01234567", admin: true },
    });
    const owner = cookie(claimed);
    const status = async () =>
      (
        await app.inject({
          url: "/api/v1/installation/status",
          headers: { cookie: owner },
        })
      ).json();
    const initial = await status();
    expect(initial).toMatchObject({
      paired: true,
      householdId: "11111111-1111-4111-8111-111111111111",
      clientId: claimed.json().id,
    });
    expect(initial.serverId).toBe(db.settings.get("server.instanceId"));
    db.accounts.linkCloudUser("household-main", { cloudUserId: "cloud-owner" });
    expect(await status()).toEqual(initial);
    db.accounts.detachDeletedCloudUser("household-main", "cloud-owner");
    expect(await status()).toEqual(initial);
    expect(access.householdAccountId()).toBe("household-main");
    expect(() => access.bindHousehold("missing-household")).toThrow();
    expect(access.householdAccountId()).toBe("household-main");
  });
  it("binds existing and newly paired clients to the canonical household", async () => {
    const { app, access, db } = fixture();
    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/installation/authorize",
      payload: { masterPin: "01234567", admin: true },
    });
    const owner = cookie(claimed);
    const started = await app.inject({
      method: "POST",
      url: "/api/v1/installation/pair",
      payload: { name: "TV" },
    });
    const request = started.json();
    await app.inject({
      method: "POST",
      url: "/api/v1/installation/decision",
      headers: { cookie: owner },
      payload: {
        requestId: request.requestId,
        code: request.code,
        approve: true,
      },
    });
    db.accounts.upsert({ id: "restored-household", name: "Restored home" });
    db.settings.set(
      "household.id.restored-household",
      "22222222-2222-4222-8222-222222222222",
    );
    access.bindHousehold("restored-household");
    const approved = await app.inject({
      method: "POST",
      url: "/api/v1/installation/poll",
      headers: { cookie: cookie(started) },
      payload: { requestId: request.requestId },
    });
    expect(approved.json().status).toBe("approved");
    for (const token of [owner, cookie(approved)]) {
      const status = (
        await app.inject({
          url: "/api/v1/installation/status",
          headers: { cookie: token },
        })
      ).json();
      expect(status).toMatchObject({
        paired: true,
        householdId: "22222222-2222-4222-8222-222222222222",
      });
      expect(status.clientId).toMatch(/^[a-f0-9-]{36}$/);
    }
  });
  it("upgrades a legacy client binding and rejects credentials copied to another server", async () => {
    const original = fixture();
    const other = fixture();
    const claimed = await original.app.inject({
      method: "POST",
      url: "/api/v1/installation/authorize",
      payload: { masterPin: "01234567", admin: true },
    });
    const owner = cookie(claimed);
    const state = original.db.settings.get<{
      claimed: boolean;
      devices: Record<string, unknown>[];
    }>("server.localAccess")!;
    delete state.devices[0]!.serverId;
    original.db.settings.set("server.localAccess", state);
    expect(
      (
        await original.app.inject({
          url: "/api/v1/installation/status",
          headers: { cookie: owner },
        })
      ).json().paired,
    ).toBe(true);
    const upgraded =
      original.db.settings.get<typeof state>("server.localAccess")!;
    expect(upgraded.devices[0]!.serverId).toBe(
      original.db.settings.get("server.instanceId"),
    );
    other.db.settings.set("server.localAccess", upgraded);
    const foreign = await other.app.inject({
      url: "/api/v1/installation/status",
      headers: { cookie: owner },
    });
    expect(foreign.json()).toMatchObject({
      paired: false,
      clientId: null,
      householdId: null,
    });
    expect(
      (
        await other.app.inject({
          url: "/api/v1/private",
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await original.app.inject({
          url: "/api/v1/private",
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("requires the household Master PIN and blocks unapproved clients", async () => {
    const { app } = fixture();
    expect((await app.inject("/api/v1/private")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installation/authorize",
          payload: { masterPin: "99999999", admin: true },
        })
      ).statusCode,
    ).toBe(403);
    const owner = await app.inject({
      method: "POST",
      url: "/api/v1/installation/authorize",
      payload: { masterPin: "01234567", admin: true },
    });
    expect(owner.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/v1/private",
          headers: { cookie: cookie(owner) },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("binds approval to the requesting browser and supports revocation", async () => {
    const { app, advance } = fixture();
    const owner = cookie(
      await app.inject({
        method: "POST",
        url: "/api/v1/installation/authorize",
        payload: { masterPin: "01234567", admin: true },
      }),
    );
    const request = await app.inject({
      method: "POST",
      url: "/api/v1/installation/pair",
      payload: { name: "Living room" },
    });
    const body = request.json();
    const poll = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/installation/poll",
        headers: { cookie: cookie(request) },
        payload: { requestId: body.requestId },
      });
    expect((await poll()).json().status).toBe("pending");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installation/poll",
          payload: { requestId: body.requestId },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installation/decision",
          headers: { cookie: owner },
          payload: {
            requestId: body.requestId,
            code: body.code,
            approve: true,
          },
        })
      ).statusCode,
    ).toBe(200);
    advance(3000);
    const approved = await poll();
    expect(approved.json().status).toBe("approved");
    const viewer = cookie(approved);
    expect(
      (
        await app.inject({
          url: "/api/v1/private",
          headers: { cookie: viewer },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/v1/installation/devices",
          headers: { cookie: viewer },
        })
      ).statusCode,
    ).toBe(403);
    const devices = (
      await app.inject({
        url: "/api/v1/installation/devices",
        headers: { cookie: owner },
      })
    ).json().devices;
    const id = devices.find(
      (device: { role: string }) => device.role === "viewer",
    ).id;
    await app.inject({
      method: "POST",
      url: "/api/v1/installation/revoke",
      headers: { cookie: owner },
      payload: { deviceId: id },
    });
    expect(
      (
        await app.inject({
          url: "/api/v1/private",
          headers: { cookie: viewer },
        })
      ).statusCode,
    ).toBe(401);
    expect((await poll()).statusCode).toBe(403);
  });
  it("enforces a polling interval and denies a pairing after five incorrect codes", async () => {
    const { app, advance } = fixture();
    const owner = cookie(
      await app.inject({
        method: "POST",
        url: "/api/v1/installation/authorize",
        payload: { masterPin: "01234567", admin: true },
      }),
    );
    const request = await app.inject({
      method: "POST",
      url: "/api/v1/installation/pair",
      payload: { name: "Code check" },
    });
    const body = request.json();
    const poll = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/installation/poll",
        headers: { cookie: cookie(request) },
        payload: { requestId: body.requestId },
      });
    expect((await poll()).json().status).toBe("pending");
    const tooFast = await poll();
    expect(tooFast.statusCode).toBe(429);
    expect(tooFast.headers["retry-after"]).toBe("3");
    for (let attempt = 0; attempt < 5; attempt++) {
      const wrong = await app.inject({
        method: "POST",
        url: "/api/v1/installation/decision",
        headers: { cookie: owner },
        payload: { requestId: body.requestId, code: "WRONG", approve: true },
      });
      expect(wrong.statusCode).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installation/decision",
          headers: { cookie: owner },
          payload: {
            requestId: body.requestId,
            code: body.code,
            approve: true,
          },
        })
      ).statusCode,
    ).toBe(404);
    advance(3000);
    expect((await poll()).json().status).toBe("denied");
  });
  it("limits the alternate health host to loopback connections", async () => {
    const { app } = fixture();
    expect(
      (
        await app.inject({
          url: "/api/v1/installation/status",
          remoteAddress: "192.168.1.100",
          headers: { host: "127.0.0.1:4400" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/v1/installation/status",
          remoteAddress: "127.0.0.1",
          headers: { host: "127.0.0.1:4400" },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("rejects foreign origins, DNS rebinding hosts and expired pairing", async () => {
    const { app, advance } = fixture();
    expect(
      (
        await app.inject({
          url: "/api/v1/installation/status",
          headers: { host: "evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installation/authorize",
          headers: { origin: "https://evil.example" },
          payload: { masterPin: "01234567", admin: true },
        })
      ).statusCode,
    ).toBe(403);
    await app.inject({
      method: "POST",
      url: "/api/v1/installation/authorize",
      payload: { masterPin: "01234567", admin: true },
    });
    const request = await app.inject({
      method: "POST",
      url: "/api/v1/installation/pair",
      payload: { name: "Expired" },
    });
    advance(301_000);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/installation/poll",
      headers: { cookie: cookie(request) },
      payload: { requestId: request.json().requestId },
    });
    expect(response.json().status).toBe("expired");
  });
});
