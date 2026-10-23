import type { DB } from "../db.js";
import { includedChannels, type ChannelView } from "../filter/channels.js";
import { formatXmltvTime, epgWindow } from "../epg/time.js";
import { getSettings } from "../settings.js";

/** Same id in the M3U (tvg-id) and in the guide (<channel id>), so Jellyfin maps every channel by itself. */
export const outputChannelId = (streamId: number) => `ch${streamId}`;

export interface OutputUrls {
  playlist: string;
  epg: string;
  epgGz: string;
  stream: (streamId: number) => string;
}

export function outputUrls(baseUrl: string, token: string, streamFormat: "ts" | "m3u8"): OutputUrls {
  const base = `${baseUrl}/o/${token}`;
  return {
    playlist: `${base}/playlist.m3u`,
    epg: `${base}/epg.xml`,
    epgGz: `${base}/epg.xml.gz`,
    stream: (id) => `${baseUrl}/s/${token}/${id}.${streamFormat}`,
  };
}

const attr = (v: string) => v.replace(/["\r\n]/g, (c) => (c === '"' ? "'" : " ")).trim();

export function buildM3u(db: DB, urls: OutputUrls): string {
  const channels = includedChannels(db);
  const guideIcons = guideIconLookup(db);
  const lines = [`#EXTM3U x-tvg-url="${urls.epg}" url-tvg="${urls.epg}"`];
  for (const c of channels) {
    const logo = c.logo || guideIcons.get(c.streamId) || "";
    lines.push(
      `#EXTINF:-1 tvg-id="${outputChannelId(c.streamId)}" tvg-name="${attr(c.name)}" tvg-logo="${attr(logo)}" ` +
        `tvg-chno="${c.number}" group-title="${attr(c.group)}",${c.name.replace(/[\r\n]/g, " ")}`,
    );
    lines.push(urls.stream(c.streamId));
  }
  return lines.join("\n") + "\n";
}

// XML 1.0 forbids most control characters; some feeds contain them anyway.
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function xml(text: string): string {
  return text
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface ProgrammeRow {
  start: number;
  stop: number;
  title: string;
  sub_title: string | null;
  description: string | null;
  categories: string | null;
  episode_num: string | null;
  icon: string | null;
  rating: string | null;
  is_new: number;
  previously_shown: number;
}

export function buildXmltv(db: DB): string {
  const settings = getSettings(db);
  const window = epgWindow(settings.epgDays, settings.epgPastDays);
  const channels = includedChannels(db);
  const mapping = new Map(
    (db.prepare("SELECT stream_id, source_id, epg_channel_id FROM channel_epg").all() as {
      stream_id: number;
      source_id: number | null;
      epg_channel_id: string | null;
    }[]).map((r) => [r.stream_id, r]),
  );
  const guideIcons = guideIconLookup(db);
  const selectProgrammes = db.prepare(
    `SELECT start, stop, title, sub_title, description, categories, episode_num, icon, rating, is_new, previously_shown
     FROM programmes WHERE source_id = ? AND channel_id = ? AND stop > ? AND start < ? ORDER BY start`,
  );

  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
    '<tv generator-info-name="Channelarr">',
  ];
  for (const c of channels) {
    const logo = c.logo || guideIcons.get(c.streamId);
    out.push(`  <channel id="${xml(outputChannelId(c.streamId))}">`);
    out.push(`    <display-name>${xml(c.name)}</display-name>`);
    if (logo) out.push(`    <icon src="${xml(logo)}" />`);
    out.push("  </channel>");
  }
  for (const c of channels) {
    const m = mapping.get(c.streamId);
    let rows: ProgrammeRow[] = [];
    if (m?.source_id != null && m.epg_channel_id) {
      rows = selectProgrammes.all(m.source_id, m.epg_channel_id, window.from, window.to) as unknown as ProgrammeRow[];
    }
    if (!rows.length) rows = dummyProgrammes(c, window.from, window.to, settings.dummyBlockMinutes);
    writeProgrammes(out, outputChannelId(c.streamId), clipOverlaps(rows));
  }
  out.push("</tv>");
  return out.join("\n") + "\n";
}

function writeProgrammes(out: string[], channelId: string, rows: ProgrammeRow[]) {
  const cid = xml(channelId);
  for (const p of rows) {
    out.push(`  <programme start="${formatXmltvTime(p.start)}" stop="${formatXmltvTime(p.stop)}" channel="${cid}">`);
    out.push(`    <title>${xml(p.title)}</title>`);
    if (p.sub_title) out.push(`    <sub-title>${xml(p.sub_title)}</sub-title>`);
    if (p.description) out.push(`    <desc>${xml(p.description)}</desc>`);
    for (const cat of parseJson<string[]>(p.categories) ?? []) out.push(`    <category>${xml(cat)}</category>`);
    if (p.icon) out.push(`    <icon src="${xml(p.icon)}" />`);
    for (const e of parseJson<{ system: string | null; value: string }[]>(p.episode_num) ?? []) {
      out.push(`    <episode-num${e.system ? ` system="${xml(e.system)}"` : ""}>${xml(e.value)}</episode-num>`);
    }
    if (p.previously_shown) out.push("    <previously-shown />");
    if (p.is_new) out.push("    <new />");
    if (p.rating) out.push(`    <rating><value>${xml(p.rating)}</value></rating>`);
    out.push("  </programme>");
  }
}

/** Guides sometimes overlap programmes; Jellyfin shows those as stacked entries, so trim each to the next start. */
export function clipOverlaps<T extends { start: number; stop: number }>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => a.start - b.start);
  const result: T[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = { ...sorted[i] };
    const next = sorted[i + 1];
    if (next && p.stop > next.start) p.stop = next.start;
    if (p.stop > p.start) result.push(p);
  }
  return result;
}

/** Placeholder blocks so a channel without guide data still shows up and can be played from the guide. */
export function dummyProgrammes(c: Pick<ChannelView, "name">, from: number, to: number, blockMinutes: number): ProgrammeRow[] {
  const block = blockMinutes * 60;
  const rows: ProgrammeRow[] = [];
  for (let t = from - (from % block); t < to; t += block) {
    rows.push({
      start: t, stop: t + block, title: c.name, sub_title: null, description: "No guide information available",
      categories: null, episode_num: null, icon: null, rating: null, is_new: 0, previously_shown: 0,
    });
  }
  return rows;
}

/** Guide channel icons, used when the provider has no logo for a stream. */
function guideIconLookup(db: DB): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT ce.stream_id, ec.icon FROM channel_epg ce
       JOIN epg_channels ec ON ec.source_id = ce.source_id AND ec.channel_id = ce.epg_channel_id
       WHERE ec.icon IS NOT NULL`,
    )
    .all() as { stream_id: number; icon: string }[];
  return new Map(rows.map((r) => [r.stream_id, r.icon]));
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
