import { randomUUID } from "node:crypto";
import { readFile, rename, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseAnnouncement } from "@streamer-ai/discovery";
import type { ClientState } from "./types.js";
export async function loadClientState(filename: string): Promise<ClientState> {
  try {
    const value = JSON.parse(
      await readFile(filename, "utf8"),
    ) as Partial<ClientState>;
    if (
      typeof value.clientId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.clientId)
    )
      throw new Error("Invalid client identity");
    return {
      clientId: value.clientId,
      selected: parseAnnouncement(value.selected),
    };
  } catch {
    return { clientId: randomUUID(), selected: null };
  }
}
export async function saveClientState(
  filename: string,
  value: ClientState,
): Promise<void> {
  await mkdir(dirname(filename), { recursive: true });
  const temporary = filename + ".tmp";
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, filename);
}
