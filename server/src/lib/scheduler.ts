import { getSetting, type DB } from "../db.js";
import { refreshEpg } from "../epg/refresh.js";
import { getSettings } from "../settings.js";
import { syncPlaylist } from "../sync/playlist.js";
import { getSource } from "../xtream/source.js";
import { debounce, jobState, runJob } from "./jobs.js";

export function startPlaylistSync(db: DB) {
  return runJob("playlist", async () => {
    const r = await syncPlaylist(db);
    // New or renamed channels can change matches, so the guide is rebuilt from cache right after.
    void startEpgRebuild(db);
    return `${r.streams} channels in ${r.categories} categories (${r.added} new, ${r.removed} gone)`;
  });
}

export function startEpgRefresh(db: DB) {
  return runJob("epg", () => refreshEpg(db, { download: true }));
}

export function startEpgRebuild(db: DB) {
  return runJob("epg-rebuild", () => refreshEpg(db, { download: false }));
}

/** Call after edits that change which channels are included or how they map to the guide. */
export function scheduleEpgRebuild(db: DB) {
  debounce(() => void startEpgRebuild(db));
}

export function startScheduler(db: DB) {
  const tick = () => {
    if (!getSource(db) || jobState().running) return;
    const s = getSettings(db);
    const now = Date.now();
    const lastSync = getSource(db)?.last_sync_at ?? 0;
    const lastEpg = Number(getSetting(db, "last_epg_download") ?? 0);
    if (now - lastSync > s.playlistRefreshHours * 3_600_000) {
      void startPlaylistSync(db).then(() => startEpgRefresh(db));
    } else if (now - lastEpg > s.epgRefreshHours * 3_600_000) {
      void startEpgRefresh(db);
    }
  };
  setTimeout(tick, 10_000);
  return setInterval(tick, 60_000);
}
