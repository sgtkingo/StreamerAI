import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

// Nonces of locks held by this process. In containers the server is usually
// PID 1 on every start, so a lock left by a killed container carries our own
// PID; it is only live if this process actually wrote it.
const heldNonces = new Set<string>();

function isOwnerAlive(owner: { pid?: unknown; nonce?: unknown }): boolean {
  const pid = Number(owner.pid);
  if (pid === process.pid)
    return typeof owner.nonce === "string" && heldNonces.has(owner.nonce);
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw failure;
  }
}

export function acquireServerRuntimeLock(dataDirectory: string): {
  release(): void;
} {
  const directory = resolve(dataDirectory);
  const filename = join(directory, ".streamerai-runtime.lock");
  const maintenance = () =>
    existsSync(`${directory}.streamerai-maintenance.lock`) ||
    existsSync(`${dirname(directory)}.streamerai-maintenance.lock`);
  if (maintenance()) throw new Error("Server maintenance is in progress.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  let descriptor: number;
  try {
    descriptor = openSync(filename, "wx", 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    // Only remove a well-formed lock whose owner is provably no longer alive.
    let owner: { pid?: unknown; nonce?: unknown };
    try {
      owner = JSON.parse(readFileSync(filename, "utf8")) as typeof owner;
    } catch {
      throw new Error("Cannot verify the existing server runtime lock.");
    }
    if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1)
      throw new Error("Invalid server runtime lock; inspect it locally.");
    if (isOwnerAlive(owner))
      throw new Error("The server data directory is already in use.");
    // Check the entire observed record before unlinking a stale owner.
    const current = JSON.parse(readFileSync(filename, "utf8")) as typeof owner;
    if (current.pid !== owner.pid || current.nonce !== owner.nonce)
      throw new Error("Server runtime lock changed; try again.");
    unlinkSync(filename);
    descriptor = openSync(filename, "wx", 0o600);
  }
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce }));
  } finally {
    closeSync(descriptor);
  }
  heldNonces.add(nonce);
  const release = () => {
    try {
      const owner = JSON.parse(readFileSync(filename, "utf8")) as {
        nonce?: unknown;
      };
      if (owner.nonce === nonce) unlinkSync(filename);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    } finally {
      heldNonces.delete(nonce);
    }
  };
  if (maintenance()) {
    release();
    throw new Error("Server maintenance is in progress.");
  }
  return { release };
}
