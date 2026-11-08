import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import { fixture, origin } from "../../cloud/test/helpers.js";
import { createApp } from "../src/app.js";
import { readRuntimeConfig } from "../src/runtime-config.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import {
  MasterPinService,
  masterPinSecretKey,
} from "../src/services/master-pin.js";
import { householdCloudCredentialKey } from "../src/services/household-state.js";
import {
  HouseholdBackupScheduler,
  backupScheduleKey,
} from "../src/services/household-backup-schedule.js";
import { EncryptedHouseholdService } from "../src/services/encrypted-household.js";
import { PreferredSourceStore } from "../src/services/preferred-source-store.js";
import { TitlePriorityStore } from "../src/services/title-priority-store.js";

const apps: FastifyInstance[] = [],
  databases: StreamerDatabase[] = [],
  directories: string[] = [];
let cloud: ReturnType<typeof fixture> | undefined;
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  cloud?.close();
  cloud = undefined;
});
const headers = { host: "localhost:5173", origin: "http://localhost:5173" };
const getCookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;
function server(f: ReturnType<typeof fixture>, name: string) {
  const database = openStreamerDatabase({ filename: ":memory:" }),
    secrets = new NonPersistentMemorySecretStore();
  databases.push(database);
  const directory = mkdtempSync(join(tmpdir(), `household-${name}-`));
  directories.push(directory);
  const make = () =>
    createApp({
      environment: "test",
      logger: false,
      database,
      secretStore: secrets,
      accountServiceUrl: origin,
      accountFetch: (input, init) =>
        f.worker.fetch(new Request(String(input), init), f.env),
      now: () => new Date(f.now()),
      runtimeConfig: readRuntimeConfig({
        NODE_ENV: "test",
        STREAMERAI_ACCESS_MODE: "paired",
        STREAMERAI_WEB_ORIGIN: "http://localhost:5173",
        STREAMERAI_DATA_DIR: directory,
        STREAMERAI_AGENT_MODE: "disabled",
      }),
    });
  const app = make();
  apps.push(app);
  return { app, database, secrets, make, directory };
}
async function owner(app: FastifyInstance) {
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/installation/setup",
    headers,
    payload: {},
  });
  expect(result.statusCode).toBe(200);
  return getCookie(result);
}
async function setup(app: FastifyInstance, cookie: string, pin = "01234567") {
  const local = await app.inject({
    method: "POST",
    url: "/api/v1/auth/local",
    headers: { ...headers, cookie },
    payload: { deferMasterPin: true },
  });
  expect(local.statusCode).toBe(200);
  const saved = await app.inject({
    method: "POST",
    url: "/api/v1/account/master-pin",
    headers: { ...headers, cookie },
    payload: { pin, confirmation: pin },
  });
  expect(saved.statusCode).toBe(200);
}
async function connect(
  f: ReturnType<typeof fixture>,
  app: FastifyInstance,
  cookie: string,
  adminLogin = false,
) {
  const started = await app.inject({
    method: "POST",
    url: "/api/v1/account/cloud/device",
    headers: { ...headers, cookie },
    payload: { adminLogin },
  });
  expect(started.statusCode).toBe(200);
  const approved = await f.request("/v1/device/approve", {
    method: "POST",
    account: "a",
    data: { user_code: started.json().userCode, approve: true },
  });
  expect(approved.status).toBe(200);
  return app.inject({
    method: "POST",
    url: "/api/v1/account/cloud/device/poll",
    headers: {
      ...headers,
      cookie: [cookie, getCookie(started)].filter(Boolean).join("; "),
    },
    payload: { deviceCode: started.json().deviceCode },
  });
}

it("pairs clients locally, preserves the household and PIN through cloud attach/detach, and authorizes cloud recovery locally", async () => {
  const f = (cloud = fixture()),
    first = server(f, "first"),
    admin = await owner(first.app);
  await setup(first.app, admin);
  const profile = first.database.profiles.list("local")[0]!;
  first.database.profiles.update(profile.id, {
    name: "Our viewer",
    preferences: { onboardingComplete: true },
  });
  const requested = await first.app.inject({
    method: "POST",
    url: "/api/v1/installation/pair",
    headers,
    payload: { name: "Living room TV" },
  });
  expect(requested.json().code).toMatch(/^\d{6}$/);
  expect(requested.json().verificationUriComplete).toContain(
    "http://localhost:5173/admin/pair?code=",
  );
  expect(requested.json().qrCodeDataUrl).toMatch(/^data:image\/png/);
  expect(
    (
      await first.app.inject({
        method: "POST",
        url: "/api/v1/installation/decision",
        headers: { ...headers, cookie: admin },
        payload: {
          requestId: requested.json().requestId,
          code: requested.json().code,
          approve: true,
        },
      })
    ).statusCode,
  ).toBe(200);
  const paired = await first.app.inject({
    method: "POST",
    url: "/api/v1/installation/poll",
    headers: { ...headers, cookie: getCookie(requested) },
    payload: { requestId: requested.json().requestId },
  });
  expect(paired.json().status).toBe("approved");
  const client = getCookie(paired),
    clientHeaders = { ...headers, cookie: client };
  expect(
    (
      await first.app.inject({
        url: "/api/v1/auth/status",
        headers: clientHeaders,
      })
    ).json(),
  ).toMatchObject({ authenticated: true, householdReady: true });
  expect(
    (
      await first.app.inject({
        url: "/api/v1/admin/pin-resets",
        headers: clientHeaders,
      })
    ).statusCode,
  ).toBe(403);
  const connected = await connect(f, first.app, admin);
  expect(connected.statusCode).toBe(200);
  expect(connected.json().status).toBe("approved");
  expect(first.database.accounts.getHousehold().id).toBe("local");
  expect((await new MasterPinService(first.secrets).read("local"))?.pin).toBe(
    "01234567",
  );
  expect(
    (
      await first.app.inject({
        url: "/api/v1/profiles",
        headers: clientHeaders,
      })
    ).json().items[0].name,
  ).toBe("Our viewer");
  // A restored vault can contain only a verifier, with the old PIN no longer known.
  const oldMaster = await new MasterPinService(first.secrets).read("local");
  await first.secrets.set(
    masterPinSecretKey("local"),
    JSON.stringify({ verifier: oldMaster!.verifier }),
  );
  first.database.settings.set("household.ready.local", false);
  const recovery = await connect(f, first.app, "", true);
  expect(recovery.json().status).toBe("approved");
  const recoveredOwner = getCookie(recovery);
  expect(
    (
      await first.app.inject({
        url: "/api/v1/installation/status",
        headers: { ...headers, cookie: recoveredOwner },
      })
    ).json().cloudRecoveryAuthorized,
  ).toBe(true);
  expect(
    (
      await first.app.inject({
        method: "POST",
        url: "/api/v1/admin/master-pin/reset",
        headers: { ...headers, cookie: recoveredOwner },
        payload: { newPin: "87654321", confirmation: "87654321" },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    await new MasterPinService(first.secrets).verify("local", "87654321"),
  ).toBe(true);
  expect(
    (
      await first.app.inject({
        method: "POST",
        url: "/api/v1/account/cloud/disconnect",
        headers: { ...headers, cookie: admin },
      })
    ).statusCode,
  ).toBe(200);
  expect(first.database.accounts.getHousehold().cloudUserId).toBeNull();
  expect(
    (
      await first.app.inject({
        url: "/api/v1/profiles",
        headers: clientHeaders,
      })
    ).json().items[0].name,
  ).toBe("Our viewer");
  expect((await f.request("/v1/households", { account: "a" })).status).toBe(
    200,
  );
});

it("opens setup without an installation key and grants administration only after creating the Master PIN", async () => {
  const f = (cloud = fixture()),
    home = server(f, "pin-first"),
    cookie = await owner(home.app);
  const setupHeaders = { ...headers, cookie };
  expect(existsSync(join(home.directory, "installation-bootstrap.key"))).toBe(
    false,
  );
  expect(
    (
      await home.app.inject({
        url: "/api/v1/installation/status",
        headers: setupHeaders,
      })
    ).json(),
  ).toMatchObject({
    claimed: false,
    paired: false,
    role: null,
    setupAuthorized: true,
  });
  for (const [method, url] of [
    ["GET", "/api/v1/admin/pin-resets"],
    ["GET", "/api/v1/server/ai-setup"],
    ["GET", "/api/v1/account/backup-schedule"],
    ["POST", "/api/v1/account/encrypted-household/export"],
  ] as const) {
    expect(
      (await home.app.inject({ method, url, headers: setupHeaders }))
        .statusCode,
    ).toBe(401);
  }
  expect(
    (
      await home.app.inject({
        method: "POST",
        url: "/api/v1/installation/setup",
        headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(409);
  const invalid = await home.app.inject({
    method: "POST",
    url: "/api/v1/account/master-pin",
    headers: setupHeaders,
    payload: { pin: "01234567", confirmation: "99999999" },
  });
  expect(invalid.statusCode).toBe(400);
  expect(
    (
      await home.app.inject({
        url: "/api/v1/installation/status",
        headers: setupHeaders,
      })
    ).json().role,
  ).toBeNull();
  await setup(home.app, cookie);
  expect(
    (
      await home.app.inject({
        url: "/api/v1/installation/status",
        headers: setupHeaders,
      })
    ).json(),
  ).toMatchObject({
    claimed: true,
    paired: true,
    role: "owner",
    setupAuthorized: false,
    setupAvailable: false,
  });
  expect(
    (
      await home.app.inject({
        method: "POST",
        url: "/api/v1/installation/setup",
        headers,
        payload: {},
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await home.app.inject({
        url: "/api/v1/admin/pin-resets",
        headers: setupHeaders,
      })
    ).statusCode,
  ).toBe(200);
});

it("finishes cloud sign-in with a verifier-only PIN and then asks for the household PIN", async () => {
  const f = (cloud = fixture()),
    home = server(f, "cloud-verifier-only"),
    admin = await owner(home.app);
  await setup(home.app, admin);
  home.database.profiles.update("default", { name: "Existing viewer" });
  expect((await connect(f, home.app, admin)).json().status).toBe("approved");
  const master = await new MasterPinService(home.secrets).read("local");
  await home.secrets.set(
    masterPinSecretKey("local"),
    JSON.stringify({ verifier: master!.verifier }),
  );
  home.database.settings.delete("household.ready.local");
  const connected = await connect(f, home.app, admin);
  expect(connected.statusCode).toBe(200);
  expect(connected.json().status).toBe("approved");
  const browser = { ...headers, cookie: admin };
  expect(
    (
      await home.app.inject({ url: "/api/v1/auth/status", headers: browser })
    ).json(),
  ).toMatchObject({
    authenticated: true,
    householdPinRequired: true,
    householdReady: false,
  });
  expect(
    (
      await home.app.inject({
        url: "/api/v1/installation/status",
        headers: browser,
      })
    ).json().cloudRecoveryAuthorized,
  ).toBe(true);
  expect(
    (
      await home.app.inject({
        method: "POST",
        url: "/api/v1/account/master-pin/verify",
        headers: browser,
        payload: { pin: "01234567" },
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (
      await home.app.inject({ url: "/api/v1/auth/status", headers: browser })
    ).json(),
  ).toMatchObject({ householdReady: true, householdPinRequired: false });
  expect(home.database.profiles.get("default")?.name).toBe("Existing viewer");
});

it("keeps the cloud failure stable after token redemption instead of returning a credential error on the next poll", async () => {
  const f = (cloud = fixture()),
    home = server(f, "cloud-stable-error"),
    admin = await owner(home.app);
  await setup(home.app, admin);
  let tokenRequests = 0;
  const fetchCloud = f.worker.fetch;
  f.worker.fetch = async (request, env) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/device/token") tokenRequests++;
    if (path === "/v1/households")
      return Response.json(
        { error: "temporarily_unavailable" },
        { status: 503 },
      );
    return fetchCloud(request, env);
  };
  const started = await home.app.inject({
    method: "POST",
    url: "/api/v1/account/cloud/device",
    headers: { ...headers, cookie: admin },
    payload: {},
  });
  expect(
    (
      await f.request("/v1/device/approve", {
        method: "POST",
        account: "a",
        data: { user_code: started.json().userCode, approve: true },
      })
    ).status,
  ).toBe(200);
  const poll = () =>
    home.app.inject({
      method: "POST",
      url: "/api/v1/account/cloud/device/poll",
      headers: { ...headers, cookie: admin + "; " + getCookie(started) },
      payload: { deviceCode: started.json().deviceCode },
    });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await poll();
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe("HOUSEHOLD_CLOUD_UNAVAILABLE");
  }
  expect(tokenRequests).toBe(1);
});

it("imports a cloud household with its existing PIN and keeps multiple households under one cloud account", async () => {
  const f = (cloud = fixture()),
    source = server(f, "source"),
    admin = await owner(source.app);
  await setup(source.app, admin);
  source.database.profiles.update("default", {
    name: "Imported viewer",
    preferences: { onboardingComplete: true },
  });
  source.database.discoverySessions.create({
    id: "conversation",
    profileId: "default",
    mode: "live",
    context: { question: "Private cinema question" },
  });
  source.database.discoverySessions.appendMessage({
    id: "message",
    sessionId: "conversation",
    role: "user",
    content: { text: "A quiet film" },
  });
  new PreferredSourceStore(source.database).set(
    "default",
    "uncached-title",
    "chosen-file",
  );
  new TitlePriorityStore(source.database, () => new Date(f.now())).toggle(
    "default",
    "uncached-title",
  );
  expect((await connect(f, source.app, admin)).json().status).toBe("approved");
  const exported = await source.app.inject({
    method: "POST",
    url: "/api/v1/account/encrypted-household/export",
    headers: { ...headers, cookie: admin },
    payload: {},
  });
  expect(exported.statusCode).toBe(200);
  const credential = JSON.parse(
    (await source.secrets.get(householdCloudCredentialKey("local")))!,
  ) as { token: string };
  const uploaded = await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: credential.token,
    data: { expectedRevision: 0, envelope: exported.json() },
  });
  expect(uploaded.status).toBe(200);
  const destination = server(f, "destination"),
    destOwner = await owner(destination.app);
  const linked = await connect(f, destination.app, destOwner);
  expect(linked.statusCode).toBe(200);
  expect(
    (
      await destination.app.inject({
        url: "/api/v1/auth/status",
        headers: { ...headers, cookie: destOwner },
      })
    ).json(),
  ).toMatchObject({
    householdRestoreRequired: true,
    masterPinSetupRequired: false,
  });
  expect(
    await new MasterPinService(destination.secrets).read("local"),
  ).toBeNull();
  expect(
    (
      await destination.app.inject({
        method: "POST",
        url: "/api/v1/account/master-pin",
        headers: { ...headers, cookie: destOwner },
        payload: { pin: "99999999", confirmation: "99999999" },
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await destination.app.inject({
        method: "POST",
        url: "/api/v1/account/cloud/device",
        headers: { ...headers, cookie: destOwner },
        payload: { adminLogin: true },
      })
    ).statusCode,
  ).toBe(409);
  const wrongPin = await destination.app.inject({
    method: "POST",
    url: "/api/v1/account/encrypted-household/restore",
    headers: { ...headers, cookie: destOwner },
    payload: {
      envelope: exported.json(),
      recoveryKey: "99999999",
      cloudRevision: 1,
      confirm: "restore-into-empty-household",
    },
  });
  expect(wrongPin.statusCode).toBe(400);
  expect(
    await new MasterPinService(destination.secrets).read("local"),
  ).toBeNull();
  expect(
    (
      await destination.app.inject({
        url: "/api/v1/installation/status",
        headers: { ...headers, cookie: destOwner },
      })
    ).json().role,
  ).toBeNull();
  const restored = await destination.app.inject({
    method: "POST",
    url: "/api/v1/account/encrypted-household/restore",
    headers: { ...headers, cookie: destOwner },
    payload: {
      envelope: exported.json(),
      recoveryKey: "01234567",
      cloudRevision: 1,
      confirm: "restore-into-empty-household",
    },
  });
  expect(restored.statusCode).toBe(200);
  expect(
    (
      await destination.app.inject({
        url: "/api/v1/installation/status",
        headers: { ...headers, cookie: destOwner },
      })
    ).json(),
  ).toMatchObject({ role: "owner", setupAuthorized: false });
  expect(
    (
      await destination.app.inject({
        url: "/api/v1/auth/status",
        headers: { ...headers, cookie: destOwner },
      })
    ).json(),
  ).toMatchObject({
    householdReady: true,
    householdRestoreRequired: false,
    masterPinSetupRequired: false,
  });
  const imported = destination.database.profiles.list("local")[0]!;
  expect(imported.name).toBe("Imported viewer");
  const chats = destination.database.discoverySessions.listAllForProfile(
    imported.id,
  );
  expect(chats).toHaveLength(1);
  expect(
    destination.database.discoverySessions.listMessages(chats[0]!.id)[0]!
      .content,
  ).toEqual({ text: "A quiet film" });
  expect(
    new PreferredSourceStore(destination.database).get(
      imported.id,
      "uncached-title",
    ),
  ).toBe("chosen-file");
  expect(
    new TitlePriorityStore(
      destination.database,
      () => new Date(f.now()),
    ).exportProfile(imported.id)[0],
  ).toMatchObject({ titleId: "uncached-title", manualHigh: true });
  expect(
    (await new MasterPinService(destination.secrets).read("local"))?.pin,
  ).toBe("01234567");
  const other = server(f, "other"),
    otherOwner = await owner(other.app);
  await setup(other.app, otherOwner, "11223344");
  expect((await connect(f, other.app, otherOwner)).json().status).toBe(
    "approved",
  );
  const households = (await (
    await f.request("/v1/households", { account: "a" })
  ).json()) as { households: unknown[] };
  expect(households.households).toHaveLength(2);
}, 20_000);

it("authorizes a client by Master PIN and keeps profile recovery and backup settings local", async () => {
  const f = (cloud = fixture()),
    home = server(f, "local-management"),
    admin = await owner(home.app);
  await setup(home.app, admin);
  const authorize = (pin: string) =>
    home.app.inject({
      method: "POST",
      url: "/api/v1/installation/authorize",
      headers,
      payload: { masterPin: pin, deviceName: "Tablet", admin: false },
    });
  expect((await authorize("99999999")).statusCode).toBe(403);
  const allowed = await authorize("01234567");
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().role).toBe("viewer");
  const clientHeaders = { ...headers, cookie: getCookie(allowed) },
    ownerHeaders = { ...headers, cookie: admin };
  expect(
    (
      await home.app.inject({ url: "/api/v1/installation/discovery", headers })
    ).json(),
  ).toMatchObject({ protocol: "streamerai-discovery", version: 1 });
  expect(
    (
      await home.app.inject({
        method: "PUT",
        url: "/api/v1/account/backup-schedule",
        headers: clientHeaders,
        payload: { enabled: true, intervalMinutes: 15, cloudEnabled: false },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await home.app.inject({
        method: "PUT",
        url: "/api/v1/account/backup-schedule",
        headers: ownerHeaders,
        payload: { enabled: true, intervalMinutes: 15, cloudEnabled: false },
      })
    ).json(),
  ).toMatchObject({ intervalMinutes: 15, cloudEnabled: false });
  const profile = home.database.profiles.list("local")[0]!;
  expect(
    (
      await home.app.inject({
        method: "PUT",
        url: `/api/v1/profiles/${profile.id}/pin`,
        headers: ownerHeaders,
        payload: { pin: "1234" },
      })
    ).statusCode,
  ).toBe(200);
  const requested = await home.app.inject({
    method: "POST",
    url: `/api/v1/profiles/${profile.id}/pin-reset`,
    headers: clientHeaders,
    payload: {},
  });
  expect(requested.statusCode).toBe(200);
  const pending = await home.app.inject({
    url: "/api/v1/admin/pin-resets",
    headers: ownerHeaders,
  });
  expect(pending.json().requests).toHaveLength(1);
  expect(
    (
      await home.app.inject({
        method: "POST",
        url: `/api/v1/admin/pin-resets/${requested.json().id}/decision`,
        headers: ownerHeaders,
        payload: { approve: true },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await home.app.inject({
        method: "POST",
        url: `/api/v1/profiles/${profile.id}/pin-reset/poll`,
        headers: clientHeaders,
        payload: { requestId: requested.json().id },
      })
    ).json().status,
  ).toBe("approved");
  expect(
    (
      await home.app.inject({
        method: "PUT",
        url: `/api/v1/profiles/${profile.id}/pin`,
        headers: clientHeaders,
        payload: { pin: null },
      })
    ).statusCode,
  ).toBe(200);
  expect(home.database.profiles.getPinRecord(profile.id).hash).toBeNull();
});

it("saves scheduled local ciphertext only when due and retains it when backups are disabled", async () => {
  const f = (cloud = fixture()),
    home = server(f, "scheduled"),
    admin = await owner(home.app);
  await setup(home.app, admin);
  const scheduler = new HouseholdBackupScheduler(
    home.database,
    new EncryptedHouseholdService(home.database, home.secrets),
    home.directory,
    () => new Date(f.now()),
  );
  await scheduler.tick("local");
  const householdDirectory = join(
    home.directory,
    "household-backups",
    home.database.settings.get<string>("household.id.local")!,
  );
  expect(readdirSync(householdDirectory)).toHaveLength(1);
  const content = readFileSync(
    join(householdDirectory, readdirSync(householdDirectory)[0]!),
    "utf8",
  );
  expect(content).toContain("streamerai-master-pin-household");
  expect(content).not.toContain("01234567");
  await scheduler.tick("local");
  expect(readdirSync(householdDirectory)).toHaveLength(1);
  f.advance(60 * 60_000);
  await scheduler.tick("local");
  expect(readdirSync(householdDirectory)).toHaveLength(2);
  home.database.settings.set(backupScheduleKey("local"), {
    enabled: false,
    cloudEnabled: false,
    intervalMinutes: 60,
  });
  f.advance(60 * 60_000);
  await scheduler.tick("local");
  expect(readdirSync(householdDirectory)).toHaveLength(2);
});

it("imports an approved encrypted merge once, preserves target PIN and uploads before disconnecting the source cloud server", async () => {
  const f = (cloud = fixture()),
    source = server(f, "merge-source"),
    target = server(f, "merge-target");
  const sourceOwner = await owner(source.app),
    targetOwner = await owner(target.app);
  await setup(source.app, sourceOwner, "01234567");
  await setup(target.app, targetOwner, "87654321");
  source.database.profiles.update("default", { name: "Source viewer" });
  target.database.profiles.update("default", { name: "Target viewer" });
  expect((await connect(f, source.app, sourceOwner)).statusCode).toBe(200);
  expect((await connect(f, target.app, targetOwner)).statusCode).toBe(200);
  const credential = JSON.parse(
    (await source.secrets.get(householdCloudCredentialKey("local")))!,
  ) as { token: string };
  const sourceId = source.database.settings.get<string>("household.id.local")!,
    targetId = target.database.settings.get<string>("household.id.local")!;
  const exported = await source.app.inject({
    method: "POST",
    url: "/api/v1/account/encrypted-household/export",
    headers: { ...headers, cookie: sourceOwner },
    payload: {},
  });
  expect(
    (
      await f.request("/v1/sync/v2/checkpoint", {
        method: "PUT",
        token: credential.token,
        data: { expectedRevision: 0, envelope: exported.json() },
      })
    ).status,
  ).toBe(200);
  const requested = await f.request(`/v1/households/${sourceId}/merge`, {
    method: "POST",
    account: "a",
    data: { targetHouseholdId: targetId },
  });
  expect(requested.status).toBe(201);
  const { id } = (await requested.json()) as { id: string };
  const approved = await f.request(`/v1/household-requests/${id}/decision`, {
    method: "POST",
    account: "a",
    data: { approve: true },
  });
  expect(approved.status).toBe(200);
  const pendingMerges = await target.app.inject({
    url: "/api/v1/admin/household-merges",
    headers: { ...headers, cookie: targetOwner },
  });
  expect(pendingMerges.json().requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id, kind: "merge", requiresLocalImport: true }),
    ]),
  );
  const local = (operation: string, pin: string) =>
    target.app.inject({
      method: "POST",
      url: `/api/v1/admin/household-merge/${operation}`,
      headers: { ...headers, cookie: targetOwner },
      payload: { requestId: id, sourcePin: pin, confirm: "merge-households" },
    });
  const wrong = await local("preview", "99999999");
  expect(wrong.statusCode).toBe(400);
  expect(wrong.json().error.code).toBe("HOUSEHOLD_AUTHENTICATION_FAILED");
  expect(target.database.profiles.list("local")).toHaveLength(1);
  const preview = await local("preview", "01234567");
  expect(preview.statusCode).toBe(200);
  expect(preview.json().profiles[0].name).toBe("Source viewer");
  const merged = await local("complete", "01234567");
  expect(merged.statusCode).toBe(200);
  expect(merged.json().ok).toBe(true);
  expect((await local("complete", "01234567")).json().alreadyCompleted).toBe(
    true,
  );
  expect(
    target.database.profiles
      .list("local")
      .map((p) => p.name)
      .sort(),
  ).toEqual(["Source viewer", "Target viewer"]);
  expect(target.database.settings.get("household.id.local")).toBe(targetId);
  expect((await new MasterPinService(target.secrets).read("local"))?.pin).toBe(
    "87654321",
  );
  expect(
    (await f.request("/v1/account", { token: credential.token })).status,
  ).toBe(401);
  expect(source.database.profiles.list("local")[0]?.name).toBe("Source viewer");
}, 20_000);
