import { readFileSync } from "node:fs";
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { createWorker } from "../src/index.js";
import type { Account, Env, SessionReader } from "../src/types.js";

export const origin = "https://cloud.streamer-ai.workers.dev";
export const accounts: Record<string, Account> = {
  a: { id: "account-a", email: "alice@example.test", name: "Alice" },
  b: { id: "account-b", email: "bob@example.test", name: "Bob" },
  c: { id: "account-c", email: "carol@example.test", name: "Carol" },
};

export function masterPinVerifier(pin = "12345678") {
  const salt = randomBytes(16).toString("hex");
  return {
    salt,
    hash: pbkdf2Sync(pin, salt, 600_000, 32, "sha256").toString("hex"),
    version: randomUUID(),
  };
}
const initializedLegacyVerifier = masterPinVerifier();

export function fixture(options: { households?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const migration of [
    "0001_identity.sql",
    "0002_sync.sql",
    "0003_sync_retention.sql",
    "0004_email_login.sql",
    "0005_deleted_device.sql",
    "0006_account_merge.sql",
    "0007_source_feedback.sql",
    "0008_profile_source_feedback.sql",
    "0009_encrypted_checkpoint.sql",
    "0010_account_pins.sql",
    "0011_households.sql",
  ]) {
    if (migration === "0011_households.sql" && options.households === false)
      continue;
    sqlite.exec(
      readFileSync(
        new URL(`../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  let time = Date.parse("2026-11-01T12:00:00.000Z");
  for (const account of Object.values(accounts)) {
    sqlite
      .prepare(
        'INSERT INTO "user" (id, email, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?)',
      )
      .run(account.id, account.email, account.name, time, time);
  }
  // Fixture owners have completed the browser's legacy initialization. Tests
  // for uninitialized or new accounts explicitly put them back in that state.
  sqlite
    .prepare(
      "UPDATE cloud_master_pin SET setup_required = 0, verifier_json = ?",
    )
    .run(JSON.stringify(initializedLegacyVerifier));
  class Prepared {
    values: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) {
      this.values = values;
      return this;
    }
    async first<T>(column?: string): Promise<T | null> {
      const result = sqlite.prepare(this.sql).get(...this.values) as
        Record<string, unknown> | undefined;
      return ((column ? result?.[column] : result) as T | null) ?? null;
    }
    execute() {
      const statement = sqlite.prepare(this.sql);
      if (statement.reader) {
        const rows = statement.all(...this.values);
        return { success: true, results: rows, meta: { changes: 0 } };
      }
      const result = statement.run(...this.values);
      return {
        success: true,
        results: [],
        meta: {
          changes: result.changes,
          last_row_id: Number(result.lastInsertRowid),
        },
      };
    }
    async run() {
      return this.execute();
    }
    async all() {
      return this.execute();
    }
    async raw() {
      return sqlite
        .prepare(this.sql)
        .raw()
        .all(...this.values);
    }
  }
  const db = {
    prepare: (sql: string) => new Prepared(sql),
    batch: async (statements: Prepared[]) =>
      sqlite.transaction(() =>
        statements.map((statement) => statement.execute()),
      )(),
    exec: async (sql: string) => sqlite.exec(sql),
  } as unknown as D1Database;
  const auth: SessionReader = {
    handler: async () => Response.json({ mocked: true }),
    getSession: async (request) => {
      const account = accounts[request.headers.get("x-test-account") ?? ""];
      return account
        ? {
            ...account,
            authenticatedAt: Number(
              request.headers.get("x-test-auth-at") ?? time,
            ),
          }
        : null;
    },
  };
  const worker = createWorker(() => auth, { now: () => time });
  const env: Env = {
    DB: db,
    AUTH_ORIGIN: origin,
    BETTER_AUTH_SECRET: "a-safe-random-looking-test-secret-0123456789abcdef",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
  const request = async (
    path: string,
    options: {
      method?: string;
      account?: string;
      token?: string;
      data?: unknown;
      origin?: string;
      authenticatedAt?: number;
    } = {},
  ) => {
    const headers = new Headers();
    if (options.account) headers.set("x-test-account", options.account);
    if (options.authenticatedAt !== undefined)
      headers.set("x-test-auth-at", String(options.authenticatedAt));
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    if (options.method && options.method !== "GET")
      headers.set("origin", options.origin ?? origin);
    if (options.data !== undefined)
      headers.set("content-type", "application/json");
    return worker.fetch(
      new Request(origin + path, {
        method: options.method ?? "GET",
        headers,
        body:
          options.data === undefined ? undefined : JSON.stringify(options.data),
      }),
      env,
    );
  };
  return {
    sqlite,
    db,
    env,
    worker,
    request,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    close: () => sqlite.close(),
  };
}
