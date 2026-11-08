import { createServer } from "node:http";
import dgram from "node:dgram";
import { afterEach, expect, it } from "vitest";
import {
  DISCOVERY_PROTOCOL,
  discoverServers,
  normalizeServerUrl,
  parseAnnouncement,
  startDiscoveryResponder,
  verifyDiscoveredServer,
} from "../src/index.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of close.splice(0)) await fn();
});
const household = {
  serverId: "server-123",
  householdId: "home-123",
  name: "Living room",
  url: "http://127.0.0.1:8080",
};

it("discovers a local server through a nonce-bound UDP exchange and deduplicates retries", async () => {
  const responder = await startDiscoveryResponder({
    getAnnouncement: () => household,
    port: 0,
    address: "127.0.0.1",
    group: null,
  });
  close.push(responder.close);
  const found = await discoverServers({
    targets: ["127.0.0.1"],
    port: responder.port,
    group: null,
    timeoutMs: 150,
  });
  expect(found).toEqual([
    { protocol: DISCOVERY_PROTOCOL, version: 1, ...household },
  ]);
});
it("rejects malformed announcements, nonce mismatches and privileged URL schemes", () => {
  expect(
    parseAnnouncement(
      {
        protocol: DISCOVERY_PROTOCOL,
        version: 1,
        ...household,
        nonce: "other",
      },
      "expected",
    ),
  ).toBeNull();
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:secret@server",
    "http://localhost/#setup=secret",
    "http://localhost/path",
    "http://public.example",
    "http://fd.public.example",
  ])
    expect(() => normalizeServerUrl(url)).toThrow();
  expect(
    parseAnnouncement({
      protocol: DISCOVERY_PROTOCOL,
      version: 1,
      ...household,
      name: "<script>",
    }),
  ).not.toBeNull();
});
it("does not answer arbitrary or oversized UDP messages", async () => {
  const responder = await startDiscoveryResponder({
    getAnnouncement: () => household,
    port: 0,
    address: "127.0.0.1",
    group: null,
  });
  close.push(responder.close);
  const socket = dgram.createSocket("udp4");
  let answers = 0;
  socket.on("message", () => answers++);
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  socket.send(Buffer.from("x".repeat(5000)), responder.port, "127.0.0.1");
  socket.send(
    Buffer.from(
      JSON.stringify({
        protocol: DISCOVERY_PROTOCOL,
        version: 1,
        type: "discover",
        nonce: "invalid",
      }),
    ),
    responder.port,
    "127.0.0.1",
  );
  await new Promise((resolve) => setTimeout(resolve, 70));
  socket.close();
  expect(answers).toBe(0);
});
it("checks the HTTP server identity before connecting and preserves the verified origin", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        protocol: DISCOVERY_PROTOCOL,
        version: 1,
        ...household,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP port");
  const url = `http://127.0.0.1:${address.port}`;
  expect(
    await verifyDiscoveredServer(url, { expectedServerId: household.serverId }),
  ).toMatchObject({ serverId: household.serverId, url });
  await expect(
    verifyDiscoveredServer(url, { expectedServerId: "another-server" }),
  ).rejects.toThrow("identity changed");
});
it("bounds the identity response before parsing it", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4097));
    },
  });
  let cancelled = false;
  const reader = body.getReader();
  const fakeFetch = (async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: () => reader.read(),
        cancel: async () => {
          cancelled = true;
          await reader.cancel();
        },
      }),
    },
  })) as unknown as typeof fetch;
  await expect(
    verifyDiscoveredServer("http://127.0.0.1", { fetch: fakeFetch }),
  ).rejects.toThrow("Invalid server identity response");
  expect(cancelled).toBe(true);
});
