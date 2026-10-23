import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { epgCacheDir } from "../config.js";
import { SHORT_EPG_SOURCE_ID, transaction, type DB, setSetting } from "../db.js";
import { includedChannels, type ChannelView } from "../filter/channels.js";
import { setStep } from "../lib/jobs.js";
import { getSettings } from "../settings.js";
import { DEFAULT_USER_AGENT, openStream, redact, type XtreamClient } from "../xtream/client.js";
import { getClient } from "../xtream/source.js";
import { buildIndexes, channelNormNames, enabledEpgSources, matchChannel, type EpgMatch } from "./match.js";
import { openGuideFile, parseXmltv, type XmltvChannel, type XmltvProgramme } from "./parse.js";
import { epgWindow, type EpgWindow } from "./time.js";

export const guideFile = (sourceId: number) => path.join(epgCacheDir(), `source-${sourceId}.xml`);

export interface RefreshOptions {
  /** false re-matches and re-reads the cached guide files without contacting the provider. */
  download: boolean;
  client?: XtreamClient;
}

export async function refreshEpg(db: DB, opts: RefreshOptions): Promise<string> {
  const settings = getSettings(db);
  const client = opts.client ?? getClient(db);
  const window = epgWindow(settings.epgDays, settings.epgPastDays);
  const sources = enabledEpgSources(db);
  fs.mkdirSync(epgCacheDir(), { recursive: true });

  // 1. Download (keeps the last good file when a download fails).
  if (opts.download) {
    for (const source of sources) {
      setStep(`Downloading ${source.name}`);
      try {
        const url = source.kind === "xtream" ? client?.xmltvUrl() : source.url;
        if (!url) throw new Error(source.kind === "xtream" ? "No IPTV source configured" : "No URL set");
        await downloadGuide(url, guideFile(source.id), client?.userAgent ?? DEFAULT_USER_AGENT);
        db.prepare("UPDATE epg_sources SET last_fetch_at = ?, status = 'ok', error = NULL WHERE id = ?").run(Date.now(), source.id);
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err));
        db.prepare("UPDATE epg_sources SET last_fetch_at = ?, status = 'error', error = ? WHERE id = ?").run(
          Date.now(),
          message,
          source.id,
        );
      }
    }
  }

  // 2. Read the channel list of every guide.
  for (const source of sources) {
    const file = guideFile(source.id);
    if (!fs.existsSync(file)) continue;
    setStep(`Reading channels from ${source.name}`);
    const channels: XmltvChannel[] = [];
    try {
      await parseXmltv(openGuideFile(file), { onChannel: (c) => channels.push(c) });
    } catch (err) {
      setSourceError(db, source.id, `Could not read guide: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    transaction(db, () => {
      db.prepare("DELETE FROM epg_channels WHERE source_id = ?").run(source.id);
      const insert = db.prepare(
        "INSERT OR IGNORE INTO epg_channels (source_id, channel_id, names, norm_names, icon) VALUES (?, ?, ?, ?, ?)",
      );
      for (const c of channels) {
        insert.run(source.id, c.id, JSON.stringify(c.names), channelNormNames(c.names, c.id), c.icon);
      }
      db.prepare("UPDATE epg_sources SET channel_count = ? WHERE id = ?").run(channels.length, source.id);
    });
  }

  // 3. Match every included channel to a guide channel.
  setStep("Matching channels to guide data");
  const channels = includedChannels(db);
  const indexes = buildIndexes(db);
  const matches = new Map<number, EpgMatch>(channels.map((c) => [c.streamId, matchChannel(c, indexes)]));

  // 4. Load programmes, but only for the guide channels in use.
  const counts = new Map<string, number>();
  for (const source of sources) {
    const wanted = new Set<string>();
    for (const m of matches.values()) if (m.sourceId === source.id && m.channelId) wanted.add(m.channelId);
    const file = guideFile(source.id);
    if (!wanted.size || !fs.existsSync(file)) {
      db.prepare("DELETE FROM programmes WHERE source_id = ?").run(source.id);
      db.prepare("UPDATE epg_sources SET programme_count = 0 WHERE id = ?").run(source.id);
      continue;
    }
    setStep(`Loading programmes from ${source.name}`);
    const programmes: XmltvProgramme[] = [];
    try {
      await parseXmltv(openGuideFile(file), {
        wantProgramme: (ch, start, stop) => wanted.has(ch) && stop > window.from && start < window.to,
        onProgramme: (p) => programmes.push(p),
      });
    } catch (err) {
      setSourceError(db, source.id, `Could not read programmes: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    transaction(db, () => {
      db.prepare("DELETE FROM programmes WHERE source_id = ?").run(source.id);
      const insert = insertProgrammeStmt(db);
      for (const p of programmes) {
        insert.run(
          source.id, p.channel, p.start, p.stop, p.title, p.subTitle, p.description,
          p.categories.length ? JSON.stringify(p.categories) : null,
          p.episodeNums.length ? JSON.stringify(p.episodeNums) : null,
          p.icon, p.rating, p.isNew ? 1 : 0, p.previouslyShown ? 1 : 0,
        );
        const key = `${source.id}:${p.channel}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      db.prepare("UPDATE epg_sources SET programme_count = ? WHERE id = ?").run(programmes.length, source.id);
    });
  }

  // 5. Per-channel EPG from the provider API for channels the guides don't cover.
  const uncovered = channels.filter((c) => {
    const m = matches.get(c.streamId)!;
    if (c.epgMode === "dummy") return false;
    return !m.channelId || !counts.get(`${m.sourceId}:${m.channelId}`);
  });
  const shortCounts = await shortEpgFallback(db, client, uncovered, window, opts.download);
  for (const [streamId, n] of shortCounts) {
    if (n > 0) matches.set(streamId, { sourceId: SHORT_EPG_SOURCE_ID, channelId: String(streamId), method: "short-epg" });
  }

  // 6. Record the result for the export and the coverage page.
  const summary = { guide: 0, shortEpg: 0, dummy: 0 };
  transaction(db, () => {
    db.exec("DELETE FROM channel_epg");
    const insert = db.prepare(
      "INSERT INTO channel_epg (stream_id, source_id, epg_channel_id, method, programme_count) VALUES (?, ?, ?, ?, ?)",
    );
    for (const c of channels) {
      const m = matches.get(c.streamId)!;
      let count =
        m.method === "short-epg" ? (shortCounts.get(c.streamId) ?? 0) : m.channelId ? (counts.get(`${m.sourceId}:${m.channelId}`) ?? 0) : 0;
      // A guide match without programmes in the window is shown as a placeholder.
      const method = count > 0 ? m.method : m.method === "manual" ? "manual" : "dummy";
      if (method === "dummy") count = 0;
      insert.run(c.streamId, method === "dummy" ? null : m.sourceId, method === "dummy" ? null : m.channelId, method, count);
      if (method === "short-epg") summary.shortEpg++;
      else if (method === "dummy") summary.dummy++;
      else summary.guide++;
    }
  });
  if (opts.download) setSetting(db, "last_epg_download", String(Date.now()));
  setSetting(db, "last_epg_rebuild", String(Date.now()));
  return `${channels.length} channels: ${summary.guide} from guides, ${summary.shortEpg} from per-channel EPG, ${summary.dummy} placeholder`;
}

async function shortEpgFallback(
  db: DB,
  client: XtreamClient | undefined,
  candidates: ChannelView[],
  window: EpgWindow,
  forceRefetch: boolean,
): Promise<Map<number, number>> {
  const settings = getSettings(db);
  const result = new Map<number, number>();
  const keep = new Set<string>();
  if (settings.shortEpgFallback && client && candidates.length) {
    const existing = new Map(
      (
        db
          .prepare("SELECT channel_id, COUNT(*) AS n FROM programmes WHERE source_id = ? AND stop > ? GROUP BY channel_id")
          .all(SHORT_EPG_SOURCE_ID, Math.floor(Date.now() / 1000)) as { channel_id: string; n: number }[]
      ).map((r) => [r.channel_id, r.n]),
    );
    const todo = candidates.slice(0, settings.shortEpgMaxChannels);
    let done = 0;
    const worker = async () => {
      for (let c = todo.shift(); c; c = todo.shift()) {
        const key = String(c.streamId);
        keep.add(key);
        done++;
        if (!forceRefetch && existing.get(key)) {
          result.set(c.streamId, existing.get(key)!);
          continue;
        }
        setStep(`Per-channel EPG ${done}/${Math.min(candidates.length, settings.shortEpgMaxChannels)}`);
        try {
          const listings = (await client.channelEpg(c.streamId)).filter((l) => l.stop_timestamp > window.from && l.start_timestamp < window.to);
          transaction(db, () => {
            db.prepare("DELETE FROM programmes WHERE source_id = ? AND channel_id = ?").run(SHORT_EPG_SOURCE_ID, key);
            const insert = insertProgrammeStmt(db);
            for (const l of listings) {
              insert.run(SHORT_EPG_SOURCE_ID, key, l.start_timestamp, l.stop_timestamp, l.title, null, l.description || null, null, null, null, null, 0, 0);
            }
          });
          result.set(c.streamId, listings.length);
        } catch {
          result.set(c.streamId, existing.get(key) ?? 0);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
  }
  // Drop per-channel data for channels that no longer need it.
  const stale = (db.prepare("SELECT DISTINCT channel_id FROM programmes WHERE source_id = ?").all(SHORT_EPG_SOURCE_ID) as { channel_id: string }[])
    .map((r) => r.channel_id)
    .filter((id) => !keep.has(id));
  const del = db.prepare("DELETE FROM programmes WHERE source_id = ? AND channel_id = ?");
  for (const id of stale) del.run(SHORT_EPG_SOURCE_ID, id);
  return result;
}

const insertProgrammeStmt = (db: DB) =>
  db.prepare(
    `INSERT INTO programmes (source_id, channel_id, start, stop, title, sub_title, description, categories, episode_num, icon, rating, is_new, previously_shown)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

function setSourceError(db: DB, sourceId: number, message: string) {
  db.prepare("UPDATE epg_sources SET status = 'error', error = ? WHERE id = ?").run(redact(message), sourceId);
}

/** Downloads to a temp file and swaps it in only when it looks like XMLTV. */
export async function downloadGuide(url: string, dest: string, userAgent: string) {
  const tmp = `${dest}.download`;
  try {
    await pipeline(await openStream(url, userAgent, 15 * 60_000), fs.createWriteStream(tmp));
    const fd = fs.openSync(tmp, "r");
    const head = Buffer.alloc(2048);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const isGzip = head[0] === 0x1f && head[1] === 0x8b;
    const text = head.subarray(0, n).toString("utf8");
    if (!isGzip && !/<tv[\s>]|<\?xml/i.test(text)) {
      throw new Error(n === 0 ? "Guide is empty" : "Response is not an XMLTV guide");
    }
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
