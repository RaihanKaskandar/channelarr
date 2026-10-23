import type { DB } from "../db.js";
import type { ChannelView } from "../filter/channels.js";
import { normalizeName } from "./normalize.js";

export type MatchMethod = "manual" | "tvg-id" | "name" | "short-epg" | "dummy";

export interface EpgMatch {
  sourceId: number | null;
  channelId: string | null;
  method: MatchMethod;
}

interface SourceIndex {
  sourceId: number;
  byId: Map<string, string>;
  byName: Map<string, string>;
}

/** Enabled sources in priority order: the provider's own guide first, then extra XMLTV feeds. */
export function enabledEpgSources(db: DB) {
  return db
    .prepare(
      "SELECT id, kind, name, url FROM epg_sources WHERE enabled = 1 ORDER BY CASE kind WHEN 'xtream' THEN 0 ELSE 1 END, priority, id",
    )
    .all() as { id: number; kind: "xtream" | "xmltv"; name: string; url: string | null }[];
}

export function buildIndexes(db: DB): SourceIndex[] {
  const rows = db.prepare("SELECT channel_id, norm_names FROM epg_channels WHERE source_id = ?");
  return enabledEpgSources(db).map((s) => {
    const byId = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const r of rows.all(s.id) as { channel_id: string; norm_names: string }[]) {
      byId.set(r.channel_id.toLowerCase(), r.channel_id);
      for (const n of r.norm_names.split("|")) if (n && !byName.has(n)) byName.set(n, r.channel_id);
    }
    return { sourceId: s.id, byId, byName };
  });
}

/**
 * Same order of preference as Dispatcharr: an explicit pick, then the provider's tvg-id
 * (epg_channel_id) as an exact channel id, then a normalised name. Channels that match nothing
 * get no source here; the refresh then tries the per-channel EPG and finally a placeholder guide.
 */
export function matchChannel(channel: ChannelView, indexes: SourceIndex[]): EpgMatch {
  if (channel.epgMode === "dummy") return { sourceId: null, channelId: null, method: "dummy" };
  if (channel.epgMode === "manual" && channel.epgSourceId != null && channel.epgOverrideChannelId) {
    return { sourceId: channel.epgSourceId, channelId: channel.epgOverrideChannelId, method: "manual" };
  }
  const tvgId = channel.epgChannelId?.trim().toLowerCase();
  if (tvgId) {
    for (const idx of indexes) {
      const hit = idx.byId.get(tvgId);
      if (hit) return { sourceId: idx.sourceId, channelId: hit, method: "tvg-id" };
    }
  }
  const names = [...new Set([channel.name, channel.providerName].map(normalizeName).filter(Boolean))];
  for (const idx of indexes) {
    for (const n of names) {
      const hit = idx.byName.get(n);
      if (hit) return { sourceId: idx.sourceId, channelId: hit, method: "name" };
    }
  }
  // Last resort: the provider's tvg-id spelled differently ("npo1.nl" vs "NPO.1.nl"). It comes after the
  // name because some providers attach wrong ids, and a wrong guide is worse than a placeholder.
  const normId = tvgId ? normalizeName(tvgId) : "";
  if (normId) {
    for (const idx of indexes) {
      const hit = idx.byName.get(normId);
      if (hit) return { sourceId: idx.sourceId, channelId: hit, method: "tvg-id" };
    }
  }
  return { sourceId: null, channelId: null, method: "dummy" };
}

export function channelNormNames(names: string[], id: string): string {
  return [...new Set([...names, id].map(normalizeName).filter(Boolean))].join("|");
}
