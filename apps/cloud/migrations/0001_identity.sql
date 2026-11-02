-- Better Auth's native Kysely/D1 schema. Never store application provider credentials here.
CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user_id ON "session"("userId");
CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" INTEGER,
  "refreshTokenExpiresAt" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  UNIQUE("providerId", "accountId")
);
CREATE INDEX IF NOT EXISTS account_user_id ON "account"("userId");
CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verification_identifier ON "verification"("identifier");

CREATE TABLE cloud_rate_limit (
  id TEXT PRIMARY KEY NOT NULL,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX cloud_rate_limit_expiry ON cloud_rate_limit(expires_at);
CREATE TABLE cloud_device_grant (
  device_hash TEXT PRIMARY KEY NOT NULL,
  user_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login' CHECK(purpose IN ('login', 'pin-reset')),
  profile_name TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'consumed')),
  account_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER NOT NULL DEFAULT 0,
  interval_ms INTEGER NOT NULL DEFAULT 5000,
  redeem_nonce TEXT
);
CREATE INDEX cloud_device_grant_expiry ON cloud_device_grant(expires_at);
CREATE TABLE cloud_device (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login' CHECK(purpose IN ('login', 'pin-reset')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX cloud_device_account ON cloud_device(account_id);
