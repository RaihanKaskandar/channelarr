import type { DB } from "../db.js";
import { XtreamClient, normalizeServerUrl, type XtreamAccount } from "./client.js";

export interface SourceRow {
  server_url: string;
  username: string;
  password: string;
  user_agent: string | null;
  stream_format: "ts" | "m3u8";
  account_json: string | null;
  last_sync_at: number | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
}

export function getSource(db: DB): SourceRow | undefined {
  return db.prepare("SELECT * FROM source WHERE id = 1").get() as SourceRow | undefined;
}

export function getClient(db: DB): XtreamClient | undefined {
  const s = getSource(db);
  if (!s) return undefined;
  return new XtreamClient({ serverUrl: s.server_url, username: s.username, password: s.password, userAgent: s.user_agent });
}

export interface SourceInput {
  serverUrl: string;
  username: string;
  /** Omit to keep the stored password. */
  password?: string;
  userAgent?: string | null;
  streamFormat?: "ts" | "m3u8";
}

export function saveSource(db: DB, input: SourceInput, account: XtreamAccount) {
  const existing = getSource(db);
  const password = input.password ?? existing?.password;
  if (!password) throw new Error("Password is required");
  db.prepare(
    `INSERT INTO source (id, server_url, username, password, user_agent, stream_format, account_json)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET server_url = excluded.server_url, username = excluded.username,
       password = excluded.password, user_agent = excluded.user_agent,
       stream_format = excluded.stream_format, account_json = excluded.account_json`,
  ).run(
    normalizeServerUrl(input.serverUrl),
    input.username.trim(),
    password,
    input.userAgent?.trim() || null,
    input.streamFormat ?? existing?.stream_format ?? "ts",
    JSON.stringify(account),
  );
  ensureXtreamEpgSource(db);
}

/** The provider's own xmltv.php is always the first EPG source. */
export function ensureXtreamEpgSource(db: DB) {
  const row = db.prepare("SELECT id FROM epg_sources WHERE kind = 'xtream'").get();
  if (!row) {
    db.prepare("INSERT INTO epg_sources (kind, name, priority) VALUES ('xtream', 'Provider guide (xmltv.php)', 0)").run();
  }
}

/** What the UI may see: never the password. */
export function publicSource(s: SourceRow | undefined) {
  if (!s) return null;
  return {
    serverUrl: s.server_url,
    username: s.username,
    hasPassword: Boolean(s.password),
    userAgent: s.user_agent,
    streamFormat: s.stream_format,
    account: s.account_json ? (JSON.parse(s.account_json) as XtreamAccount) : null,
    lastSyncAt: s.last_sync_at,
    lastSyncStatus: s.last_sync_status,
    lastSyncError: s.last_sync_error,
  };
}
