import type BetterSqlite3 from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "application_settings_and_profiles",
    sql: `
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 120),
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE profiles (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 120),
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
        locale TEXT NOT NULL CHECK (locale IN ('en', 'cs', 'de')),
        preferences_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(preferences_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER profiles_limit_before_insert
      BEFORE INSERT ON profiles
      WHEN (SELECT count(*) FROM profiles) >= 5
      BEGIN
        SELECT RAISE(ABORT, 'PROFILE_LIMIT_REACHED');
      END;
    `,
  },
  {
    version: 2,
    name: "integration_connections_and_jobs",
    sql: `
      CREATE TABLE integration_connections (
        integration_id TEXT PRIMARY KEY NOT NULL CHECK (
          integration_id IN ('tmdb', 'webshare', 'ollama', 'csfd', 'brave-search', 'cloudflare-sync')
        ),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        setup_status TEXT NOT NULL CHECK (
          setup_status IN (
            'not-configured', 'needs-user-action', 'checking', 'ready', 'degraded', 'failed', 'disabled'
          )
        ),
        health_status TEXT NOT NULL CHECK (
          health_status IN ('unknown', 'healthy', 'degraded', 'unavailable', 'disabled')
        ),
        secret_ref TEXT CHECK (secret_ref IS NULL OR length(secret_ref) BETWEEN 1 AND 512),
        health_code TEXT CHECK (health_code IS NULL OR length(health_code) BETWEEN 1 AND 80),
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO integration_connections (
        integration_id, enabled, setup_status, health_status, created_at, updated_at
      ) VALUES
        ('tmdb', 1, 'needs-user-action', 'unknown', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('webshare', 1, 'needs-user-action', 'unknown', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('ollama', 0, 'disabled', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('csfd', 0, 'disabled', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('brave-search', 0, 'disabled', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('cloudflare-sync', 0, 'disabled', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 120),
        kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 120),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        unique_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX jobs_claim_idx
        ON jobs (state, available_at, priority DESC, created_at)
        WHERE state IN ('queued', 'running');
    `,
  },
  {
    version: 3,
    name: "sync_outbox",
    sql: `
      CREATE TABLE sync_outbox (
        op_id TEXT PRIMARY KEY NOT NULL CHECK (length(op_id) BETWEEN 1 AND 120),
        device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 120),
        profile_id TEXT,
        entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 120),
        entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 240),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        hlc TEXT NOT NULL CHECK (length(hlc) BETWEEN 1 AND 120),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        tombstone INTEGER NOT NULL DEFAULT 0 CHECK (tombstone IN (0, 1)),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        last_error TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX sync_outbox_pending_idx
        ON sync_outbox (available_at, created_at)
        WHERE delivered_at IS NULL;
    `,
  },
  {
    version: 4,
    name: "on_demand_catalog_library_and_history",
    sql: `
      CREATE TABLE canonical_titles (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
        kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
        normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
        metadata_provider TEXT NOT NULL CHECK (length(metadata_provider) BETWEEN 1 AND 80),
        metadata_validated_at TEXT NOT NULL,
        availability_state TEXT NOT NULL CHECK (
          availability_state IN ('available', 'partial', 'unavailable', 'unknown')
        ),
        availability_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE external_entity_mappings (
        title_id TEXT NOT NULL REFERENCES canonical_titles(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 80),
        external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 160),
        entity_type TEXT NOT NULL CHECK (entity_type IN ('movie', 'series', 'season', 'episode')),
        retrieved_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, external_id, entity_type)
      ) STRICT;

      CREATE INDEX external_entity_mappings_title_idx ON external_entity_mappings (title_id);

      CREATE TABLE library_entries (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        title_id TEXT NOT NULL REFERENCES canonical_titles(id) ON DELETE CASCADE,
        membership_reason TEXT NOT NULL CHECK (membership_reason IN ('explicit', 'playback')),
        state TEXT NOT NULL CHECK (state IN ('saved', 'in-progress', 'completed')),
        progress_percent REAL CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_played_at TEXT,
        PRIMARY KEY (profile_id, title_id)
      ) STRICT;

      CREATE INDEX library_entries_profile_state_idx
        ON library_entries (profile_id, state, updated_at DESC);

      CREATE TABLE watch_history_events (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 120),
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        title_id TEXT NOT NULL REFERENCES canonical_titles(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN ('start', 'progress', 'stop', 'complete')),
        episode_label TEXT CHECK (episode_label IS NULL OR length(episode_label) BETWEEN 1 AND 120),
        progress_percent REAL NOT NULL CHECK (progress_percent BETWEEN 0 AND 100),
        occurred_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX watch_history_events_profile_time_idx
        ON watch_history_events (profile_id, occurred_at DESC, id DESC);
    `,
  },
  {
    version: 5,
    name: "durable_discovery_sessions_and_idempotency",
    sql: `
      CREATE TABLE discovery_sessions (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 120),
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('live', 'preview')),
        state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'needs-setup', 'failed')),
        context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (
          (state = 'active' AND completed_at IS NULL)
          OR (state <> 'active' AND completed_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX discovery_sessions_profile_time_idx
        ON discovery_sessions (profile_id, updated_at DESC, id DESC);

      CREATE TABLE discovery_messages (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 120),
        session_id TEXT NOT NULL REFERENCES discovery_sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content_json TEXT NOT NULL CHECK (json_valid(content_json)),
        request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 120),
        created_at TEXT NOT NULL,
        UNIQUE (session_id, ordinal)
      ) STRICT;

      CREATE UNIQUE INDEX discovery_messages_request_role_idx
        ON discovery_messages (session_id, request_id, role)
        WHERE request_id IS NOT NULL;

      CREATE INDEX discovery_messages_session_order_idx
        ON discovery_messages (session_id, ordinal);

      CREATE TABLE idempotency_records (
        scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 160),
        key TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 120),
        request_hash TEXT NOT NULL CHECK (length(request_hash) BETWEEN 16 AND 128),
        state TEXT NOT NULL CHECK (state IN ('in-progress', 'completed', 'failed')),
        response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
        status_code INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (scope, key),
        CHECK (
          (state = 'in-progress' AND response_json IS NULL AND status_code IS NULL AND error_code IS NULL)
          OR (state = 'completed' AND response_json IS NOT NULL AND status_code IS NOT NULL AND error_code IS NULL)
          OR (state = 'failed' AND response_json IS NOT NULL AND status_code IS NOT NULL AND error_code IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at);
    `,
  },
  {
    version: 6,
    name: "per_title_and_episode_playback_positions",
    sql: `
      CREATE TABLE playback_positions (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        title_id TEXT NOT NULL REFERENCES canonical_titles(id) ON DELETE CASCADE,
        position_key TEXT NOT NULL CHECK (length(position_key) BETWEEN 1 AND 40),
        season_number INTEGER CHECK (season_number IS NULL OR season_number > 0),
        episode_number INTEGER CHECK (episode_number IS NULL OR episode_number > 0),
        position_seconds REAL NOT NULL CHECK (position_seconds >= 0),
        duration_seconds REAL NOT NULL CHECK (duration_seconds >= 0),
        progress_percent REAL NOT NULL CHECK (progress_percent BETWEEN 0 AND 100),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, title_id, position_key),
        CHECK ((season_number IS NULL) = (episode_number IS NULL))
      ) STRICT;

      CREATE INDEX playback_positions_title_recent_idx
        ON playback_positions (profile_id, title_id, updated_at DESC);
    `,
  },
  {
    version: 7,
    name: "extensible_integration_ids",
    sql: `
      CREATE TABLE integration_connections_next (
        integration_id TEXT PRIMARY KEY NOT NULL CHECK (
          length(integration_id) BETWEEN 1 AND 80
          AND integration_id NOT GLOB '*[^a-z0-9-]*'
          AND substr(integration_id, 1, 1) GLOB '[a-z]'
        ),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        setup_status TEXT NOT NULL CHECK (
          setup_status IN (
            'not-configured', 'needs-user-action', 'checking', 'ready', 'degraded', 'failed', 'disabled'
          )
        ),
        health_status TEXT NOT NULL CHECK (
          health_status IN ('unknown', 'healthy', 'degraded', 'unavailable', 'disabled')
        ),
        secret_ref TEXT CHECK (secret_ref IS NULL OR length(secret_ref) BETWEEN 1 AND 512),
        health_code TEXT CHECK (health_code IS NULL OR length(health_code) BETWEEN 1 AND 80),
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO integration_connections_next
      SELECT * FROM integration_connections;
      DROP TABLE integration_connections;
      ALTER TABLE integration_connections_next RENAME TO integration_connections;

      INSERT INTO integration_connections (
        integration_id, enabled, setup_status, health_status, created_at, updated_at
      ) VALUES
        ('local-files', 0, 'disabled', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('ftp', 0, 'disabled', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('ftps', 0, 'disabled', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('nas', 0, 'disabled', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('opensubtitles', 0, 'disabled', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('titulky-com', 0, 'disabled', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `,
  },
  {
    version: 8,
    name: "profile_scoped_integrations",
    sql: `
      CREATE TABLE profile_integration_connections (
        profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 120),
        integration_id TEXT NOT NULL CHECK (
          length(integration_id) BETWEEN 1 AND 80
          AND integration_id NOT GLOB '*[^a-z0-9-]*'
          AND substr(integration_id, 1, 1) GLOB '[a-z]'
        ),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        setup_status TEXT NOT NULL CHECK (
          setup_status IN (
            'not-configured', 'needs-user-action', 'checking', 'ready', 'degraded', 'failed', 'disabled'
          )
        ),
        health_status TEXT NOT NULL CHECK (
          health_status IN ('unknown', 'healthy', 'degraded', 'unavailable', 'disabled')
        ),
        secret_ref TEXT CHECK (secret_ref IS NULL OR length(secret_ref) BETWEEN 1 AND 512),
        health_code TEXT CHECK (health_code IS NULL OR length(health_code) BETWEEN 1 AND 80),
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, integration_id)
      ) STRICT;

      CREATE INDEX profile_integration_connections_id_idx
        ON profile_integration_connections (integration_id, profile_id);

      INSERT INTO profile_integration_connections (
        profile_id, integration_id, enabled, setup_status, health_status, secret_ref,
        health_code, last_checked_at, created_at, updated_at
      )
      SELECT 'default', integration_id, enabled, setup_status, health_status, secret_ref,
        health_code, last_checked_at, created_at, updated_at
      FROM integration_connections;
    `,
  },
  {
    version: 9,
    name: "accounts_shared_integrations_and_profile_security",
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 120),
        cloud_user_id TEXT UNIQUE CHECK (cloud_user_id IS NULL OR length(cloud_user_id) BETWEEN 1 AND 120),
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
        email TEXT CHECK (email IS NULL OR length(email) BETWEEN 1 AND 320),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO accounts (id, name, created_at, updated_at)
        VALUES ('local', 'StreamerAI', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

      ALTER TABLE profiles ADD COLUMN account_id TEXT REFERENCES accounts(id);
      UPDATE profiles SET account_id = 'local';
      ALTER TABLE profiles ADD COLUMN sync_id TEXT;
      ALTER TABLE profiles ADD COLUMN pin_hash TEXT;
      ALTER TABLE profiles ADD COLUMN pin_attempts INTEGER NOT NULL DEFAULT 0 CHECK (pin_attempts >= 0);
      ALTER TABLE profiles ADD COLUMN pin_locked_until TEXT;
      ALTER TABLE profiles ADD COLUMN pin_version INTEGER NOT NULL DEFAULT 0 CHECK (pin_version >= 0);
      UPDATE profiles SET sync_id = lower(hex(randomblob(16)));
      CREATE UNIQUE INDEX profiles_sync_id_idx ON profiles (sync_id);
      CREATE INDEX profiles_account_idx ON profiles (account_id, created_at, id);
      CREATE TRIGGER profiles_identity_before_insert
      BEFORE INSERT ON profiles WHEN NEW.account_id IS NULL OR NEW.sync_id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'PROFILE_IDENTITY_REQUIRED');
      END;
      CREATE TRIGGER profiles_identity_before_update
      BEFORE UPDATE OF account_id, sync_id ON profiles WHEN NEW.account_id IS NULL OR NEW.sync_id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'PROFILE_IDENTITY_REQUIRED');
      END;
      INSERT INTO app_settings (key, value_json, updated_at)
        VALUES ('migration.accountIntegrations.sourceProfile',
          json_quote(coalesce((SELECT id FROM profiles ORDER BY created_at, id LIMIT 1), 'default')),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      DROP TRIGGER profiles_limit_before_insert;
      CREATE TRIGGER profiles_limit_before_insert
      BEFORE INSERT ON profiles
      WHEN (SELECT count(*) FROM profiles WHERE account_id = NEW.account_id) >= 5
      BEGIN
        SELECT RAISE(ABORT, 'PROFILE_LIMIT_REACHED');
      END;
      CREATE TRIGGER profiles_limit_before_transfer
      BEFORE UPDATE OF account_id ON profiles
      WHEN NEW.account_id <> OLD.account_id
        AND (SELECT count(*) FROM profiles WHERE account_id = NEW.account_id) >= 5
      BEGIN
        SELECT RAISE(ABORT, 'PROFILE_LIMIT_REACHED');
      END;

      CREATE TABLE account_integration_connections (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        integration_id TEXT NOT NULL CHECK (length(integration_id) BETWEEN 1 AND 80),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        setup_status TEXT NOT NULL,
        health_status TEXT NOT NULL,
        secret_ref TEXT,
        health_code TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, integration_id)
      ) STRICT;
      INSERT INTO account_integration_connections
        SELECT 'local', integration_id, enabled, setup_status, health_status, secret_ref,
          health_code, last_checked_at, created_at, updated_at
        FROM profile_integration_connections
        WHERE profile_id = coalesce((SELECT id FROM profiles ORDER BY created_at, id LIMIT 1), 'default');

      CREATE TABLE account_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) BETWEEN 32 AND 128),
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 120),
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE INDEX account_sessions_devices_idx ON account_sessions(account_id, device_id);
      CREATE INDEX account_sessions_expiry_idx ON account_sessions(expires_at);
    `,
  },
  {
    version: 10,
    name: "durable_account_sync_mutation_journal",
    sql:
      `
      CREATE TABLE account_sync_dirty (
        account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        changed_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO account_sync_dirty SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM accounts;
      CREATE TRIGGER account_sync_profile_insert AFTER INSERT ON profiles BEGIN
        INSERT INTO account_sync_dirty VALUES (NEW.account_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(account_id) DO UPDATE SET changed_at = excluded.changed_at;
      END;
      CREATE TRIGGER account_sync_profile_update AFTER UPDATE ON profiles BEGIN
        INSERT INTO account_sync_dirty VALUES (OLD.account_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(account_id) DO UPDATE SET changed_at = excluded.changed_at;
        INSERT INTO account_sync_dirty VALUES (NEW.account_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(account_id) DO UPDATE SET changed_at = excluded.changed_at;
      END;
      CREATE TRIGGER account_sync_profile_delete BEFORE DELETE ON profiles BEGIN
        INSERT INTO account_sync_dirty VALUES (OLD.account_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(account_id) DO UPDATE SET changed_at = excluded.changed_at;
      END;
    ` +
      ["library_entries", "watch_history_events", "playback_positions"]
        .flatMap((table) =>
          (["INSERT", "UPDATE", "DELETE"] as const).map(
            (event) => `
        CREATE TRIGGER account_sync_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
          INSERT INTO account_sync_dirty (account_id, changed_at)
            SELECT account_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM profiles
            WHERE id = ${event === "DELETE" ? "OLD" : "NEW"}.profile_id
            ON CONFLICT(account_id) DO UPDATE SET changed_at = excluded.changed_at;
        END;
      `,
          ),
        )
        .join(""),
  },
  {
    version: 11,
    name: "account_source_feedback",
    sql:
      `
      CREATE TABLE source_feedback (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(account_id, entity_id)
      ) STRICT;
      CREATE INDEX source_feedback_title ON source_feedback(account_id, json_extract(payload_json, '$.titleId'));
    ` +
      (["INSERT", "UPDATE", "DELETE"] as const)
        .map(
          (event) => `
      CREATE TRIGGER account_sync_source_feedback_${event.toLowerCase()} AFTER ${event} ON source_feedback BEGIN
        INSERT INTO account_sync_dirty (account_id, changed_at)
        VALUES (${event === "DELETE" ? "OLD" : "NEW"}.account_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(account_id) DO UPDATE SET changed_at = excluded.changed_at;
      END;
    `,
        )
        .join(""),
  },
  {
    version: 12,
    name: "reset_account_source_feedback_for_profile_votes",
    sql: `
      DELETE FROM source_feedback;
      DELETE FROM sync_outbox WHERE entity_type = 'source-feedback';
      UPDATE app_settings SET value_json = json_set(
        value_json,
        '$.entries', json(COALESCE((
          SELECT json_group_object(entry.key, json(entry.value))
          FROM json_each(app_settings.value_json, '$.entries') AS entry
          WHERE json_extract(entry.value, '$.operation.kind') != 'source-feedback'
        ), '{}')),
        '$.deferred', json(COALESCE((
          SELECT json_group_array(json(item.value))
          FROM json_each(app_settings.value_json, '$.deferred') AS item
          WHERE json_extract(item.value, '$.kind') != 'source-feedback'
        ), '[]'))
      ) WHERE key GLOB 'accountSync.*';
    `,
  },
] as const;

export function applyMigrations(
  database: BetterSqlite3.Database,
  now: () => string,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    (
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>
    ).map(({ version }) => version),
  );
  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    database.transaction(() => {
      database.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, now());
    })();
  }
}
