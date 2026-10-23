import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Programmes fetched per channel through get_simple_data_table live under this pseudo source. */
export const SHORT_EPG_SOURCE_ID = 0;

const migrations: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE source (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    server_url TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    user_agent TEXT,
    stream_format TEXT NOT NULL DEFAULT 'ts',
    account_json TEXT,
    last_sync_at INTEGER,
    last_sync_status TEXT,
    last_sync_error TEXT
  );

  CREATE TABLE categories (
    category_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    included INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE streams (
    stream_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    epg_channel_id TEXT,
    icon TEXT,
    category_id TEXT,
    provider_num INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX streams_category ON streams(category_id);

  -- User choices per stream. NULL means "not overridden".
  CREATE TABLE channel_prefs (
    stream_id INTEGER PRIMARY KEY,
    enabled INTEGER,
    name TEXT,
    number INTEGER,
    group_name TEXT,
    logo TEXT,
    epg_mode TEXT,          -- NULL/'auto' | 'manual' | 'dummy'
    epg_source_id INTEGER,
    epg_channel_id TEXT
  );

  CREATE TABLE rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL CHECK (action IN ('include', 'exclude')),
    pattern TEXT NOT NULL,
    is_regex INTEGER NOT NULL DEFAULT 0,
    category_id TEXT,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE epg_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('xtream', 'xmltv')),
    name TEXT NOT NULL,
    url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    last_fetch_at INTEGER,
    status TEXT,
    error TEXT,
    channel_count INTEGER NOT NULL DEFAULT 0,
    programme_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE epg_channels (
    source_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    names TEXT NOT NULL,     -- JSON array of display-names
    norm_names TEXT NOT NULL, -- '|'-joined normalised names, for matching
    icon TEXT,
    PRIMARY KEY (source_id, channel_id)
  );

  CREATE TABLE programmes (
    source_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    stop INTEGER NOT NULL,
    title TEXT NOT NULL,
    sub_title TEXT,
    description TEXT,
    categories TEXT,   -- JSON array
    episode_num TEXT,  -- JSON array of {system, value}
    icon TEXT,
    rating TEXT,
    is_new INTEGER NOT NULL DEFAULT 0,
    previously_shown INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX programmes_channel ON programmes(source_id, channel_id, start);

  -- Result of matching every included stream to guide data.
  CREATE TABLE channel_epg (
    stream_id INTEGER PRIMARY KEY,
    source_id INTEGER,
    epg_channel_id TEXT,
    method TEXT NOT NULL,   -- 'manual' | 'tvg-id' | 'name' | 'short-epg' | 'dummy'
    programme_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  `,
];

export type DB = DatabaseSync;

export function openDb(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "channelarr.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function openMemoryDb(): DB {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: DB, key: string, value: string) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}
