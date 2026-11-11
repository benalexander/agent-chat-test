/** SQLite connection and versioned schema migrations (tracked in PRAGMA user_version). */
import * as SQLite from 'expo-sqlite';

export const DB_NAME = 'agent-chat.db';

let db: SQLite.SQLiteDatabase | null = null;

/**
 * Single shared connection, opened lazily so the background task (which can
 * run before React mounts) can use it too. The first call runs migrations.
 */
export function getDb(): SQLite.SQLiteDatabase {
  if (db) return db;
  db = SQLite.openDatabaseSync(DB_NAME);
  db.execSync('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** Closes and deletes the database file; the next getDb() recreates it empty. */
export async function deleteLocalDb(): Promise<void> {
  if (db) {
    await db.closeAsync();
    db = null;
  }
  await SQLite.deleteDatabaseAsync(DB_NAME);
}

/**
 * MIGRATIONS[i] takes the schema from version i to i + 1. Never edit a shipped
 * step: append a new one.
 */
const MIGRATIONS: readonly ((d: SQLite.SQLiteDatabase) => void)[] = [
  // v1: initial schema.
  (d) =>
    d.execSync(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      rev INTEGER,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      origin TEXT NOT NULL,
      trigger TEXT,
      created_at INTEGER NOT NULL,
      complete INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS messages_rev ON messages(rev);
    CREATE INDEX IF NOT EXISTS messages_created_at ON messages(created_at);

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS bg_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      woke_at INTEGER NOT NULL,
      finished_at INTEGER,
      source TEXT NOT NULL,
      app_state TEXT,
      fetched INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      notified_at INTEGER NOT NULL,
      delay_ms INTEGER NOT NULL,
      grouped INTEGER NOT NULL DEFAULT 0,
      bg_run_id INTEGER
    );
  `),
  // v2: deliveries measured from Expo push notifications. 'local' = posted by the
  // background task; 'push' = delivered by APNs, at most one row per message.
  (d) =>
    d.execSync(`
    ALTER TABLE notification_deliveries ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
    CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_push
      ON notification_deliveries(message_id) WHERE source = 'push';
  `),
];

const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(d: SQLite.SQLiteDatabase) {
  const version = d.getFirstSync<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
  for (let v = version; v < SCHEMA_VERSION; v++) {
    d.withTransactionSync(() => {
      MIGRATIONS[v](d);
      d.execSync(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
