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
