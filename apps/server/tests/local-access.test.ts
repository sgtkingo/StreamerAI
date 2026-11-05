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
    bootstrapToken: "a".repeat(64),
    now: () => new Date(time),
  });
  access.register(app);
  app.get("/api/v1/private", async () => ({ secret: "household" }));
  fixtures.push({ app, db, directory });
  return {
    app,
    access,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
describe("installation access", () => {
  it("requires a host-side bootstrap proof and blocks unapproved clients", async () => {
    const { app } = fixture();
    expect((await app.inject("/api/v1/private")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installation/claim",
          payload: { token: "b".repeat(64) },
        })
      ).statusCode,
    ).toBe(403);
    const owner = await app.inject({
      method: "POST",
      url: "/api/v1/installation/claim",
      payload: { token: "a".repeat(64) },
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
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installation/claim",
          payload: { token: "a".repeat(64) },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("binds approval to the requesting browser and supports revocation", async () => {
    const { app, advance } = fixture();
    const owner = cookie(
      await app.inject({
        method: "POST",
        url: "/api/v1/installation/claim",
        payload: { token: "a".repeat(64) },
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
        url: "/api/v1/installation/claim",
        payload: { token: "a".repeat(64) },
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
          url: "/api/v1/installation/claim",
          headers: { origin: "https://evil.example" },
          payload: { token: "a".repeat(64) },
        })
      ).statusCode,
    ).toBe(403);
    await app.inject({
      method: "POST",
      url: "/api/v1/installation/claim",
      payload: { token: "a".repeat(64) },
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
