import {
  argon2,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parseEnv } from "node:util";
import {
  inspectStreamerDatabaseSnapshot,
  prepareRestoredStreamerDatabase,
  snapshotStreamerDatabaseFile,
  type ServerDatabaseSummary,
} from "@streamer-ai/database";
import { acquireServerRuntimeLock } from "../services/runtime-lock.js";

const MAGIC = Buffer.from("STREAMERAI-BACKUP\0", "ascii");
const FORMAT = "streamerai-offline-backup";
const MAX_HEADER_BYTES = 4096;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
/** First format bounds RAM use; large media/model bundles need a future streaming format. */
export const MAX_SERVER_BACKUP_BYTES = 256 * 1024 * 1024;
const KDF = {
  algorithm: "argon2id",
  memory: 65_536,
  passes: 3,
  parallelism: 1,
} as const;
const VAULT_AAD = Buffer.from("streamer-ai-secret-vault:v1");

type BackupFileKind =
  | "database"
  | "vault"
  | "vault-key"
  | "configuration"
  | "media"
  | "model"
  | "installer";
export interface BackupExtraFile {
  source: string;
  /** Portable path below extras/, for example extras/configuration/source.env. */
  path: string;
  kind: "configuration" | "media" | "model" | "installer";
}
interface ManifestFile {
  path: string;
  kind: BackupFileKind;
  bytes: number;
  sha256: string;
}
export interface ServerBackupManifest {
  format: typeof FORMAT;
  version: 1;
  appVersion: string;
  createdAt: string;
  sourcePlatform: string;
  database: ServerDatabaseSummary;
  files: ManifestFile[];
  excluded: string[];
}
export interface CreateServerBackupOptions {
  dataDirectory: string;
  databaseFile?: string;
  vaultFile: string;
  keyFile: string;
  outputFile: string;
  passphrase: string;
  appVersion: string;
  extraFiles?: BackupExtraFile[];
}
export interface OpenServerBackupOptions {
  file: string;
  passphrase: string;
}
export interface RestoreServerBackupOptions extends OpenServerBackupOptions {
  /** Managed state root with data/, keys/, runtime.env; never a runtime release or project. */
  targetDirectory: string;
  mode: "replace" | "new-server";
  overwriteConfirmed?: boolean;
  sourceRetiredConfirmed?: boolean;
}
export interface RestoredServerBackup {
  manifest: ServerBackupManifest;
  dataDirectory: string;
  databaseFile: string;
  vaultFile: string;
  keyFile: string;
  environmentFile: string;
  rollbackDirectory: string | null;
  rollbackBackupFile: string | null;
  warnings: string[];
}
interface HeaderCore {
  format: typeof FORMAT;
  version: 1;
  algorithm: "aes-256-gcm";
  kdf: typeof KDF;
  salt: string;
  wrapIv: string;
  payloadIv: string;
}
interface Header extends HeaderCore {
  wrappedKey: string;
  wrapTag: string;
}
interface BackupContents {
  manifest: ServerBackupManifest;
  files: Map<string, Buffer>;
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function missing(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}
function decode(value: unknown, bytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Invalid backup encoding.");
  const decoded = Buffer.from(value, "base64");
  if (bytes !== undefined && decoded.length !== bytes)
    throw new Error("Invalid backup encoding length.");
  return decoded;
}
function portablePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    /[\\:]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[ .]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("Backup contains an unsafe or nonportable path.");
}
function ensureOutside(path: string, directory: string): void {
  const child = relative(resolve(directory), resolve(path));
  if (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  )
    throw new Error(
      "Backup output must be outside the source or restored state directory.",
    );
}
async function readRegularFile(
  filename: string,
  maximum = MAX_SERVER_BACKUP_BYTES,
): Promise<Buffer> {
  const metadata = await lstat(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximum
  )
    throw new Error(
      "Backup input must be a regular file within the supported size limit.",
    );
  const file = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.size !== metadata.size ||
      opened.size > maximum
    )
      throw new Error("Backup input changed while opening it.");
    const bytes = await file.readFile();
    if (bytes.length > maximum)
      throw new Error("Backup input grew beyond the supported size limit.");
    return bytes;
  } finally {
    await file.close();
  }
}
function masterKey(bytes: Buffer): Buffer {
  const encoded = bytes.toString("utf8").trim();
  const decoded = /^[a-f\d]{64}$/i.test(encoded)
    ? Buffer.from(encoded, "hex")
    : decode(encoded, 32);
  if (decoded.length !== 32) throw new Error("Backup vault key is invalid.");
  return decoded;
}
function decryptVault(bytes: Buffer, keyBytes: Buffer): Record<string, string> {
  const vault: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !object(vault) ||
    vault.version !== 1 ||
    vault.algorithm !== "aes-256-gcm"
  )
    throw new Error("Unsupported vault format.");
  const key = masterKey(keyBytes);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, decode(vault.iv, 12));
    decipher.setAAD(VAULT_AAD);
    decipher.setAuthTag(decode(vault.tag, 16));
    plaintext = Buffer.concat([
      decipher.update(decode(vault.ciphertext)),
      decipher.final(),
    ]);
    const values: unknown = JSON.parse(plaintext.toString("utf8"));
    if (
      !object(values) ||
      Object.entries(values).some(
        ([name, value]) => !name || typeof value !== "string",
      )
    )
      throw new Error("Invalid vault contents.");
    return values as Record<string, string>;
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
function encryptVault(
  values: Record<string, string>,
  keyBytes: Buffer,
): Buffer {
  const key = masterKey(keyBytes),
    iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(VAULT_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(values), "utf8"),
      cipher.final(),
    ]);
    return Buffer.from(
      `${JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") })}\n`,
    );
  } finally {
    key.fill(0);
  }
}
async function wrappingKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (!passphrase || Buffer.byteLength(passphrase) > 1024)
    throw new Error(
      "Backup passphrase must contain between 1 and 1024 UTF-8 bytes.",
    );
  const message = Buffer.from(passphrase, "utf8");
  try {
    return await new Promise<Buffer>((done, fail) =>
      argon2(
        "argon2id",
        { ...KDF, message, nonce: salt, tagLength: 32 },
        (error, key) => (error ? fail(error) : done(key)),
      ),
    );
  } finally {
    message.fill(0);
  }
}
function seal(
  key: Buffer,
  iv: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): { bytes: Buffer; tag: Buffer } {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  return {
    bytes: Buffer.concat([cipher.update(plaintext), cipher.final()]),
    tag: cipher.getAuthTag(),
  };
}
function unseal(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  aad: Buffer,
  tag: Buffer,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const first = decipher.update(ciphertext);
  try {
    return Buffer.concat([first, decipher.final()]);
  } finally {
    first.fill(0);
  }
}
async function encrypt(
  contents: BackupContents,
  passphrase: string,
): Promise<Buffer> {
  const manifest = Buffer.from(JSON.stringify(contents.manifest)),
    length = Buffer.alloc(4);
  length.writeUInt32BE(manifest.length);
  const plaintext = Buffer.concat([
    length,
    manifest,
    ...contents.manifest.files.map((file) => contents.files.get(file.path)!),
  ]);
  const salt = randomBytes(16),
    key = randomBytes(32),
    wrapping = await wrappingKey(passphrase, salt);
  try {
    const core: HeaderCore = {
      format: FORMAT,
      version: 1,
      algorithm: "aes-256-gcm",
      kdf: KDF,
      salt: salt.toString("base64"),
      wrapIv: randomBytes(12).toString("base64"),
      payloadIv: randomBytes(12).toString("base64"),
    };
    const wrapped = seal(
      wrapping,
      decode(core.wrapIv),
      key,
      Buffer.from(JSON.stringify(core)),
    );
    const header: Header = {
      ...core,
      wrappedKey: wrapped.bytes.toString("base64"),
      wrapTag: wrapped.tag.toString("base64"),
    };
    const encoded = Buffer.from(JSON.stringify(header)),
      headerLength = Buffer.alloc(4);
    headerLength.writeUInt32BE(encoded.length);
    const sealed = seal(key, decode(core.payloadIv), plaintext, encoded);
    return Buffer.concat([
      MAGIC,
      headerLength,
      encoded,
      sealed.bytes,
      sealed.tag,
    ]);
  } finally {
    key.fill(0);
    wrapping.fill(0);
    plaintext.fill(0);
  }
}
function parseManifest(value: unknown): ServerBackupManifest {
  if (
    !object(value) ||
    value.format !== FORMAT ||
    value.version !== 1 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.appVersion !== "string" ||
    value.appVersion.length > 100 ||
    typeof value.sourcePlatform !== "string" ||
    !object(value.database) ||
    !Array.isArray(value.files) ||
    value.files.length < 3 ||
    value.files.length > 4096 ||
    !Array.isArray(value.excluded) ||
    !value.excluded.every((item) => typeof item === "string")
  )
    throw new Error("Invalid backup manifest.");
  const names = new Set<string>();
  let total = 0;
  for (const entry of value.files) {
    if (
      !object(entry) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error("Invalid backup file manifest.");
    portablePath(entry.path);
    if (!(
      (entry.path === "data/streamer-ai.db" && entry.kind === "database") ||
      (entry.path === "data/secrets.vault" && entry.kind === "vault") ||
      (entry.path === "keys/master.key" && entry.kind === "vault-key") ||
      (entry.path.startsWith("extras/") &&
        ["configuration", "media", "model", "installer"].includes(
          String(entry.kind),
        ))
    ))
      throw new Error("Backup contains unsupported state files.");
    const normalized = entry.path.toLowerCase();
    if (
      names.has(normalized) ||
      [...names].some(
        (name) =>
          name.startsWith(`${normalized}/`) ||
          normalized.startsWith(`${name}/`),
      )
    )
      throw new Error("Backup contains colliding paths.");
    names.add(normalized);
    total += entry.bytes as number;
    if (total > MAX_SERVER_BACKUP_BYTES)
      throw new Error("Backup exceeds the supported size limit.");
  }
  for (const required of [
    "data/streamer-ai.db",
    "data/secrets.vault",
    "keys/master.key",
  ])
    if (!names.has(required))
      throw new Error("Backup is missing required server state.");
  return value as unknown as ServerBackupManifest;
}
async function decrypt(
  bytes: Buffer,
  passphrase: string,
): Promise<BackupContents> {
  if (
    !bytes.subarray(0, MAGIC.length).equals(MAGIC) ||
    bytes.length < MAGIC.length + 4 + 16
  )
    throw new Error("Not a StreamerAI offline backup.");
  const headerSize = bytes.readUInt32BE(MAGIC.length),
    offset = MAGIC.length + 4;
  if (
    headerSize < 1 ||
    headerSize > MAX_HEADER_BYTES ||
    offset + headerSize + 16 > bytes.length
  )
    throw new Error("Incomplete backup header.");
  const encoded = bytes.subarray(offset, offset + headerSize),
    header: unknown = JSON.parse(encoded.toString("utf8"));
  if (
    !object(header) ||
    header.format !== FORMAT ||
    header.version !== 1 ||
    header.algorithm !== "aes-256-gcm" ||
    !object(header.kdf)
  )
    throw new Error("Unsupported backup format.");
  const kdf = header.kdf;
  if (Object.entries(KDF).some(([name, item]) => kdf[name] !== item))
    throw new Error("Unsupported backup KDF parameters.");
  const salt = decode(header.salt, 16),
    wrapIv = decode(header.wrapIv, 12),
    payloadIv = decode(header.payloadIv, 12);
  const core: HeaderCore = {
    format: FORMAT,
    version: 1,
    algorithm: "aes-256-gcm",
    kdf: KDF,
    salt: header.salt as string,
    wrapIv: header.wrapIv as string,
    payloadIv: header.payloadIv as string,
  };
  const wrapping = await wrappingKey(passphrase, salt);
  let key: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    try {
      key = unseal(
        wrapping,
        wrapIv,
        decode(header.wrappedKey, 32),
        Buffer.from(JSON.stringify(core)),
        decode(header.wrapTag, 16),
      );
      plaintext = unseal(
        key,
        payloadIv,
        bytes.subarray(offset + headerSize, -16),
        encoded,
        bytes.subarray(-16),
      );
    } catch {
      throw new Error(
        "Backup could not be authenticated. Check the passphrase and file integrity.",
      );
    }
    if (plaintext.length < 4) throw new Error("Incomplete backup manifest.");
    const size = plaintext.readUInt32BE(0);
    if (size > MAX_MANIFEST_BYTES || size + 4 > plaintext.length)
      throw new Error("Invalid backup manifest length.");
    const manifest = parseManifest(
      JSON.parse(plaintext.subarray(4, 4 + size).toString("utf8")),
    );
    const files = new Map<string, Buffer>();
    let position = 4 + size;
    for (const entry of manifest.files) {
      const file = plaintext.subarray(position, position + entry.bytes);
      if (file.length !== entry.bytes || hash(file) !== entry.sha256)
        throw new Error("Backup file integrity check failed.");
      files.set(entry.path, Buffer.from(file));
      position += entry.bytes;
    }
    if (position !== plaintext.length)
      throw new Error("Backup contains unexpected trailing data.");
    const database = inspectStreamerDatabaseSnapshot(
      files.get("data/streamer-ai.db")!,
    );
    if (JSON.stringify(database) !== JSON.stringify(manifest.database))
      throw new Error("Backup database does not match its manifest.");
    decryptVault(
      files.get("data/secrets.vault")!,
      files.get("keys/master.key")!,
    );
    return { manifest, files };
  } finally {
    key?.fill(0);
    wrapping.fill(0);
    plaintext?.fill(0);
  }
}
function clear(contents: BackupContents): void {
  for (const bytes of contents.files.values()) bytes.fill(0);
}
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === "win32") {
    const identity = execFileSync(
      "whoami.exe",
      ["/user", "/fo", "csv", "/nh"],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    const sid = /S-1-\d+(?:-\d+)+/.exec(identity)?.[0];
    if (!sid)
      throw new Error(
        "Cannot determine the local backup owner for protected staging.",
      );
    execFileSync(
      "icacls.exe",
      [
        directory,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
      ],
      { stdio: "ignore", windowsHide: true, timeout: 10_000 },
    );
  }
}
async function writeSyncedFile(
  filename: string,
  bytes: Buffer | string,
): Promise<void> {
  const file = await open(filename, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function removeRestoreStage(
  stage: string,
  parent: string,
  target: string,
): Promise<void> {
  if (
    dirname(resolve(stage)) !== parent ||
    !basename(stage).startsWith(`.${basename(target)}.restore-`)
  )
    throw new Error("Invalid restore staging location.");
  await rm(stage, { recursive: true, force: true });
}
async function atomicNewFile(filename: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(resolve(filename)), { recursive: true });
  const temporary = `${resolve(filename)}.${randomUUID()}.partial`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A same-directory hard link publishes the complete file atomically without
    // ever replacing an existing backup. Unsupported filesystems fail safely.
    await link(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function contentSnapshot(
  options: CreateServerBackupOptions,
): Promise<BackupContents> {
  const dbFile =
    options.databaseFile ?? join(options.dataDirectory, "streamer-ai.db");
  const dbInfo = await lstat(dbFile);
  if (
    !dbInfo.isFile() ||
    dbInfo.isSymbolicLink() ||
    dbInfo.size > MAX_SERVER_BACKUP_BYTES
  )
    throw new Error(
      "Backup database must be a regular file within the size limit.",
    );
  const snapshot = snapshotStreamerDatabaseFile(dbFile),
    key = await readRegularFile(options.keyFile, 4096);
  let vault: Buffer;
  try {
    vault = await readRegularFile(options.vaultFile);
  } catch (error) {
    if (!missing(error)) throw error;
    vault = encryptVault({}, key);
  }
  decryptVault(vault, key);
  const files = new Map<string, Buffer>([
    ["data/streamer-ai.db", snapshot.bytes],
    ["data/secrets.vault", vault],
    ["keys/master.key", key],
  ]);
  const entries: ManifestFile[] = [...files].map(([path, bytes]) => ({
    path,
    bytes: bytes.length,
    kind: path.endsWith(".db")
      ? "database"
      : path.endsWith(".vault")
        ? "vault"
        : "vault-key",
    sha256: hash(bytes),
  }));
  let size = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const extraFiles = [...(options.extraFiles ?? [])];
  for (const name of ["runtime.env", "server.env"]) {
    const source = join(dirname(resolve(options.dataDirectory)), name);
    try {
      await lstat(source);
      const path = `extras/configuration/${name}`;
      if (!extraFiles.some((extra) => extra.path === path))
        extraFiles.push({ source, path, kind: "configuration" });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  for (const extra of extraFiles) {
    portablePath(extra.path);
    if (!extra.path.startsWith("extras/"))
      throw new Error("Additional backup files must be placed below extras/.");
    const bytes = await readRegularFile(extra.source);
    size += bytes.length;
    if (size > MAX_SERVER_BACKUP_BYTES)
      throw new Error(
        "Backup exceeds the 256 MiB state limit. Select fewer optional files.",
      );
    files.set(extra.path, bytes);
    entries.push({
      path: extra.path,
      kind: extra.kind,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
  }
  const manifest: ServerBackupManifest = {
    format: FORMAT,
    version: 1,
    appVersion: options.appVersion,
    createdAt: new Date().toISOString(),
    sourcePlatform: process.platform,
    database: snapshot.summary,
    files: entries,
    excluded: [
      "Cache, logs, temporary files and runtime binaries",
      "Local media, downloaded models and external configuration unless explicitly selected",
      "Gateway CA and device identity files; clients must re-establish trust",
    ],
  };
  parseManifest(manifest);
  return { manifest, files };
}

/** Stopped-server export. Runtime lock makes DB and vault one coherent snapshot. */
export async function previewServerBackup(
  options: Omit<CreateServerBackupOptions, "passphrase">,
): Promise<ServerBackupManifest> {
  const lock = acquireServerRuntimeLock(options.dataDirectory);
  let contents: BackupContents | undefined;
  try {
    contents = await contentSnapshot({ ...options, passphrase: "" });
    return contents.manifest;
  } finally {
    if (contents) clear(contents);
    lock.release();
  }
}

/** Stopped-server export. Runtime lock makes DB and vault one coherent snapshot. */
export async function createServerBackup(
  options: CreateServerBackupOptions,
): Promise<ServerBackupManifest> {
  if (options.passphrase.length < 12)
    throw new Error("Use a backup passphrase of at least 12 characters.");
  ensureOutside(options.outputFile, options.dataDirectory);
  const lock = acquireServerRuntimeLock(options.dataDirectory);
  let contents: BackupContents | undefined;
  try {
    contents = await contentSnapshot(options);
    const encrypted = await encrypt(contents, options.passphrase),
      checked = await decrypt(encrypted, options.passphrase);
    clear(checked);
    await atomicNewFile(options.outputFile, encrypted);
    return contents.manifest;
  } finally {
    if (contents) clear(contents);
    lock.release();
  }
}
/** Fully authenticates SQLite and vault decryption without restoring. */
export async function inspectServerBackup(
  options: OpenServerBackupOptions,
): Promise<ServerBackupManifest> {
  const contents = await decrypt(
    await readRegularFile(
      options.file,
      MAX_SERVER_BACKUP_BYTES + MAX_MANIFEST_BYTES + MAX_HEADER_BYTES,
    ),
    options.passphrase,
  );
  try {
    return contents.manifest;
  } finally {
    clear(contents);
  }
}

/** Restore a managed installation state root without contacting any network. */
export async function restoreServerBackup(
  options: RestoreServerBackupOptions,
): Promise<RestoredServerBackup> {
  if (!["replace", "new-server"].includes(options.mode))
    throw new Error("Choose replace or new-server restore mode.");
  if (options.mode === "replace" && !options.sourceRetiredConfirmed)
    throw new Error(
      "Replacement requires confirmation that the original server is retired.",
    );
  const target = resolve(options.targetDirectory),
    project = relative(target, process.cwd());
  if (
    target === dirname(target) ||
    project === "" ||
    (!project.startsWith("..") && !isAbsolute(project))
  )
    throw new Error(
      "Restore target cannot be a drive root, project directory, or its parent.",
    );
  ensureOutside(options.file, target);
  const contents = await decrypt(
    await readRegularFile(
      options.file,
      MAX_SERVER_BACKUP_BYTES + MAX_MANIFEST_BYTES + MAX_HEADER_BYTES,
    ),
    options.passphrase,
  );
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let targetExists = false;
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Restore target must be a real directory.");
    targetExists = true;
  } catch (error) {
    if (!missing(error)) {
      clear(contents);
      throw error;
    }
  }
  if (targetExists && !options.overwriteConfirmed) {
    clear(contents);
    throw new Error(
      "Existing server state requires explicit overwrite confirmation.",
    );
  }
  if (targetExists) {
    const data = await lstat(join(target, "data"));
    if (!data.isDirectory() || data.isSymbolicLink()) {
      clear(contents);
      throw new Error("Existing target is not a managed server state root.");
    }
  }
  const existingData = join(target, "data"),
    existingLock = targetExists
      ? acquireServerRuntimeLock(existingData)
      : undefined;
  const maintenance = `${target}.streamerai-maintenance.lock`,
    stage = join(parent, `.${basename(target)}.restore-${randomUUID()}`);
  const rollback = targetExists ? `${target}.rollback-${randomUUID()}` : null,
    rollbackBackup = targetExists ? `${rollback}.streamerai-backup` : null;
  let marker: Awaited<ReturnType<typeof open>> | undefined;
  let movedPrevious = false,
    installed = false,
    retainJournal = false;
  try {
    marker = await open(maintenance, "wx", 0o600);
    await marker.writeFile(
      JSON.stringify({
        format: "streamerai-restore-journal",
        version: 1,
        pid: process.pid,
        nonce: randomUUID(),
        target,
        stage,
        rollback,
      }),
    );
    await marker.sync();
    await privateDirectory(stage);
    if (targetExists) {
      // Refuse unknown/partial layouts, and create a verified encrypted rollback.
      const previous = await contentSnapshot({
        dataDirectory: existingData,
        vaultFile: join(existingData, "secrets.vault"),
        keyFile: join(target, "keys", "master.key"),
        outputFile: rollbackBackup!,
        passphrase: options.passphrase,
        appVersion: contents.manifest.appVersion,
      });
      try {
        const encrypted = await encrypt(previous, options.passphrase),
          verified = await decrypt(encrypted, options.passphrase);
        clear(verified);
        await atomicNewFile(rollbackBackup!, encrypted);
      } finally {
        clear(previous);
      }
    }
    const values = decryptVault(
      contents.files.get("data/secrets.vault")!,
      contents.files.get("keys/master.key")!,
    );
    for (const key of Object.keys(values))
      if (
        key.startsWith("account.cloud-token.") ||
        (options.mode === "new-server" &&
          /^(server|device|pairing)\./.test(key))
      )
        delete values[key];
    if (options.mode === "new-server") {
      contents.files.get("keys/master.key")!.fill(0);
      contents.files.set(
        "keys/master.key",
        Buffer.from(randomBytes(32).toString("base64")),
      );
    }
    contents.files.set(
      "data/secrets.vault",
      encryptVault(values, contents.files.get("keys/master.key")!),
    );
    for (const [path, bytes] of contents.files) {
      const filename = join(stage, ...path.split("/"));
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      await writeSyncedFile(filename, bytes);
    }
    prepareRestoredStreamerDatabase(
      join(stage, "data", "streamer-ai.db"),
      options.mode,
      new Date().toISOString(),
    );
    const paths = {
      dataDirectory: join(target, "data"),
      databaseFile: join(target, "data", "streamer-ai.db"),
      vaultFile: join(target, "data", "secrets.vault"),
      keyFile: join(target, "keys", "master.key"),
      environmentFile: join(target, "runtime.env"),
    };
    const savedConfiguration: Record<string, string> = {};
    for (const name of ["runtime.env", "server.env"]) {
      const bytes = contents.files.get(`extras/configuration/${name}`);
      if (!bytes) continue;
      for (const [key, value] of Object.entries(
        parseEnv(bytes.toString("utf8")),
      )) {
        // Paths, executable hooks, credentials and cloud sessions never become
        // active merely because they appeared in an imported env file.
        if (
          value !== undefined &&
          /^(?:STREAMERAI_(?:HOST|PORT|LOG_LEVEL|AGENT_MODE|AGENT_PROVIDER|AGENT_MODEL|AGENT_REASONING_EFFORT)|INFERENCE_(?:PROVIDER|BASE_URL|MODEL|CONTEXT_TOKENS|MAX_OUTPUT_TOKENS|TIMEOUT_MS)|OLLAMA_(?:BASE_URL|MODEL|MINIMUM_VERSION))$/.test(
            key,
          )
        )
          savedConfiguration[key] = value;
      }
    }
    const environment = {
      ...savedConfiguration,
      STREAMERAI_ACCESS_MODE: "paired",
      STREAMERAI_HOST: "127.0.0.1",
      STREAMERAI_DATA_DIR: paths.dataDirectory,
      STREAMERAI_SECRET_BACKEND: "encrypted-file",
      STREAMERAI_SECRET_VAULT_FILE: paths.vaultFile,
      STREAMERAI_SECRET_KEY_FILE: paths.keyFile,
    };
    await writeSyncedFile(
      join(stage, "runtime.env"),
      Object.entries(environment)
        .map(
          ([key, value]) =>
            `${key}=${JSON.stringify(value.replaceAll("\\", "/"))}`,
        )
        .join("\n") + "\n",
    );
    existingLock?.release();
    if (targetExists) {
      await rename(target, rollback!);
      movedPrevious = true;
    }
    await rename(stage, target);
    installed = true;
    return {
      manifest: contents.manifest,
      ...paths,
      rollbackDirectory: rollback,
      rollbackBackupFile: rollbackBackup,
      warnings: [
        "Cloud synchronization is paused; review accounts and newer remote state before reconnecting.",
        "Browser sessions were invalidated; local owner recovery and client pairing are required.",
        "Gateway trust and local media paths must be configured on the target machine.",
        "Provider credentials are restored locally; expired or device-bound tokens may require sign-in.",
      ],
    };
  } catch (error) {
    if (movedPrevious && !installed) {
      try {
        await rename(rollback!, target);
      } catch (rollbackError) {
        retainJournal = true;
        throw new AggregateError(
          [error, rollbackError],
          "Restore switch and rollback were interrupted. Run offline backup recover after stopping the process.",
        );
      }
    }
    throw error;
  } finally {
    existingLock?.release();
    clear(contents);
    try {
      if (!installed && !retainJournal) {
        await removeRestoreStage(stage, parent, target).catch(
          (error: unknown) => {
            retainJournal = true;
            throw error;
          },
        );
      }
    } finally {
      if (marker) {
        await marker.close();
        if (!retainJournal) await rm(maintenance, { force: true });
      }
    }
  }
}

/** Clean up a restore interrupted by process termination; never runs automatically on user data. */
export async function recoverInterruptedServerRestore(
  targetDirectory: string,
): Promise<{
  recoveredPreviousState: boolean;
  retainedRollbackDirectory: string | null;
}> {
  const target = resolve(targetDirectory),
    marker = `${target}.streamerai-maintenance.lock`;
  const journal: unknown = JSON.parse(
    (await readRegularFile(marker, 4096)).toString("utf8"),
  );
  if (
    !object(journal) ||
    journal.format !== "streamerai-restore-journal" ||
    journal.version !== 1 ||
    journal.target !== target ||
    !Number.isSafeInteger(journal.pid) ||
    Number(journal.pid) < 1 ||
    typeof journal.stage !== "string" ||
    !(journal.rollback === null || typeof journal.rollback === "string")
  )
    throw new Error("Invalid interrupted restore journal; inspect it locally.");
  const expectedStagePrefix = join(
    dirname(target),
    `.${basename(target)}.restore-`,
  );
  if (
    !journal.stage.startsWith(expectedStagePrefix) ||
    !/^[a-f\d-]{36}$/.test(journal.stage.slice(expectedStagePrefix.length)) ||
    (typeof journal.rollback === "string" &&
      (!journal.rollback.startsWith(`${target}.rollback-`) ||
        !/^[a-f\d-]{36}$/.test(
          journal.rollback.slice(`${target}.rollback-`.length),
        )))
  )
    throw new Error("Unsafe interrupted restore journal paths.");
  try {
    process.kill(Number(journal.pid), 0);
    throw new Error("Restore operation is still running.");
  } catch (error) {
    if (!object(error) || error.code !== "ESRCH") throw error;
  }
  const directoryExists = async (path: string) => {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Interrupted restore path must be a real directory.");
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  };
  const hasTarget = await directoryExists(target);
  const hasRollback =
    typeof journal.rollback === "string" &&
    (await directoryExists(journal.rollback));
  let recoveredPreviousState = false;
  if (!hasTarget && hasRollback) {
    const snapshot = snapshotStreamerDatabaseFile(
      join(journal.rollback as string, "data", "streamer-ai.db"),
    );
    snapshot.bytes.fill(0);
    await rename(journal.rollback as string, target);
    recoveredPreviousState = true;
  }
  if (await directoryExists(journal.stage))
    await rm(journal.stage, { recursive: true, force: true });
  await rm(marker);
  return {
    recoveredPreviousState,
    retainedRollbackDirectory:
      hasRollback && !recoveredPreviousState
        ? (journal.rollback as string)
        : null,
  };
}
