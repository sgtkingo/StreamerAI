import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  isSafeExternalUrl,
  isServerNavigation,
  isTrustedShellFrame,
  parseConnectionInput,
  REMOTE_WEB_PREFERENCES,
} from "../src/security.js";
import { loadClientState, saveClientState } from "../src/settings.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("streamerai-client-")
    )
      throw new Error(
        "Refusing to remove a directory outside the client test.",
      );
    await rm(directory, { recursive: true, force: true });
  }
});

it("limits native IPC to the top-level local chooser and excludes remote frames", () => {
  const url = "file:///app/renderer.html";
  expect(isTrustedShellFrame({ url, parent: null }, url)).toBe(true);
  for (const frame of [
    null,
    { url: "https://home.local", parent: null },
    { url: url + "?untrusted", parent: null },
    { url, parent: {} },
  ])
    expect(isTrustedShellFrame(frame, url)).toBe(false);
  expect(REMOTE_WEB_PREFERENCES).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
  });
  expect(REMOTE_WEB_PREFERENCES).not.toHaveProperty("preload");
});
it("accepts manual/QR server addresses while blocking native URL handlers and account credentials", () => {
  expect(
    parseConnectionInput(
      "streamerai://connect?url=https%3A%2F%2Fhome.local%3A8443&serverId=server-1",
    ),
  ).toEqual({ url: "https://home.local:8443", expectedServerId: "server-1" });
  expect(parseConnectionInput("http://127.0.0.1:8080/")).toEqual({
    url: "http://127.0.0.1:8080",
  });
  for (const value of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:secret@host",
    "streamerai://other?url=https%3A%2F%2Fhost",
    "https://host/#setup=secret",
    "http://public.example",
    "http://fd.public.example",
  ])
    expect(() => parseConnectionInput(value)).toThrow();
  expect(
    isSafeExternalUrl("https://cloud.streamer-ai.workers.dev/account"),
  ).toBe(true);
  for (const value of [
    "file:///test",
    "ms-settings:display",
    "intent://app",
    "https://user:secret@host",
    "http://external.example",
  ])
    expect(isSafeExternalUrl(value)).toBe(false);
  expect(
    isServerNavigation(
      "https://home.local/api/v1/profiles",
      "https://home.local",
    ),
  ).toBe(true);
  expect(
    isServerNavigation(
      "https://home.local.attacker.example",
      "https://home.local",
    ),
  ).toBe(false);
});
it("persists a random client identity independently of the selected household", async () => {
  const directory = await mkdtemp(join(tmpdir(), "streamerai-client-"));
  directories.push(directory);
  const filename = join(directory, "settings.json");
  const initial = await loadClientState(filename);
  expect(initial.clientId).toMatch(/^[a-f0-9-]{36}$/);
  expect(initial.selected).toBeNull();
  const selected = {
    protocol: "streamerai-discovery" as const,
    version: 1 as const,
    serverId: "server-1",
    householdId: "home",
    name: "Cinema",
    url: "https://home.local",
  };
  await saveClientState(filename, { ...initial, selected });
  expect(await loadClientState(filename)).toEqual({ ...initial, selected });
  expect(await readFile(filename, "utf8")).not.toContain("token");
  await writeFile(
    filename,
    JSON.stringify({
      ...initial,
      selected: { ...selected, url: "file:///etc/passwd" },
    }),
  );
  expect(await loadClientState(filename)).toEqual({
    ...initial,
    selected: null,
  });
});
