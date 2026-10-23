import { transaction, type DB } from "../db.js";
import { redact, type XtreamCategory, type XtreamClient, type XtreamLiveStream } from "../xtream/client.js";
import { getClient } from "../xtream/source.js";

export interface SyncResult {
  categories: number;
  streams: number;
  added: number;
  removed: number;
}

export async function syncPlaylist(db: DB, client: XtreamClient | undefined = getClient(db)): Promise<SyncResult> {
  if (!client) throw new Error("No IPTV source configured");
  try {
    const account = await client.account();
    const [categories, streams] = await Promise.all([client.liveCategories(), client.liveStreams()]);
    const result = importPlaylist(db, categories, streams);
    db.prepare(
      "UPDATE source SET account_json = ?, last_sync_at = ?, last_sync_status = 'ok', last_sync_error = NULL WHERE id = 1",
    ).run(JSON.stringify(account), Date.now());
    return result;
  } catch (err) {
    const message = redact(err instanceof Error ? err.message : String(err));
    db.prepare("UPDATE source SET last_sync_at = ?, last_sync_status = 'error', last_sync_error = ? WHERE id = 1").run(
      Date.now(),
      message,
    );
    throw new Error(message);
  }
}

export function importPlaylist(db: DB, categories: XtreamCategory[], streams: XtreamLiveStream[]): SyncResult {
  const now = Date.now();
  return transaction(db, () => {
    db.exec("UPDATE categories SET removed = 1");
    const upsertCategory = db.prepare(
      `INSERT INTO categories (category_id, name, position, removed) VALUES (?, ?, ?, 0)
       ON CONFLICT(category_id) DO UPDATE SET name = excluded.name, position = excluded.position, removed = 0`,
    );
    categories.forEach((c, i) => upsertCategory.run(String(c.category_id), c.category_name ?? `Category ${c.category_id}`, i));

    const known = new Set(
      (db.prepare("SELECT stream_id FROM streams WHERE removed = 0").all() as { stream_id: number }[]).map((r) => r.stream_id),
    );
    const upsertStream = db.prepare(
      `INSERT INTO streams (stream_id, name, epg_channel_id, icon, category_id, provider_num, position, removed, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(stream_id) DO UPDATE SET name = excluded.name, epg_channel_id = excluded.epg_channel_id,
         icon = excluded.icon, category_id = excluded.category_id, provider_num = excluded.provider_num,
         position = excluded.position, removed = 0, last_seen = excluded.last_seen`,
    );
    const seen = new Set<number>();
    let added = 0;
    streams.forEach((s, i) => {
      const id = Number(s.stream_id);
      if (!Number.isFinite(id) || seen.has(id)) return;
      if (s.stream_type && s.stream_type !== "live" && s.stream_type !== "created_live") return;
      seen.add(id);
      if (!known.has(id)) added++;
      upsertStream.run(
        id,
        (s.name ?? "").trim() || `Channel ${id}`,
        s.epg_channel_id?.trim() || null,
        s.stream_icon?.trim() || null,
        s.category_id != null ? String(s.category_id) : null,
        s.num != null ? Number(s.num) : null,
        i,
        now,
        now,
      );
    });
    const removed = [...known].filter((id) => !seen.has(id));
    const markRemoved = db.prepare("UPDATE streams SET removed = 1 WHERE stream_id = ?");
    for (const id of removed) markRemoved.run(id);
    return { categories: categories.length, streams: seen.size, added, removed: removed.length };
  });
}
