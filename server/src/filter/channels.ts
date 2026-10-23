import type { DB } from "../db.js";
import { cleanChannelName, isAllCaps } from "../epg/normalize.js";
import { getSettings } from "../settings.js";

export interface Rule {
  id: number;
  action: "include" | "exclude";
  pattern: string;
  is_regex: number;
  category_id: string | null;
  position: number;
}

export type IncludeReason = "manual" | "rule" | "category" | null;

export interface ChannelView {
  streamId: number;
  providerName: string;
  epgChannelId: string | null;
  providerIcon: string | null;
  categoryId: string | null;
  categoryName: string | null;
  included: boolean;
  /** Why it is in or out: an explicit toggle beats rules, rules beat the category switch. */
  reason: IncludeReason;
  excludedByRule: boolean;
  enabledOverride: boolean | null;
  name: string;
  number: number | null;
  numberOverride: number | null;
  group: string;
  logo: string | null;
  nameOverride: string | null;
  groupOverride: string | null;
  logoOverride: string | null;
  epgMode: "auto" | "manual" | "dummy";
  epgSourceId: number | null;
  epgOverrideChannelId: string | null;
}

interface Row {
  stream_id: number;
  name: string;
  epg_channel_id: string | null;
  icon: string | null;
  category_id: string | null;
  category_name: string | null;
  category_included: number | null;
  enabled: number | null;
  p_name: string | null;
  p_number: number | null;
  p_group: string | null;
  p_logo: string | null;
  epg_mode: string | null;
  epg_source_id: number | null;
  p_epg_channel_id: string | null;
}

export function compileRule(rule: Pick<Rule, "pattern" | "is_regex">): (name: string) => boolean {
  if (rule.is_regex) {
    try {
      const re = new RegExp(rule.pattern, "i");
      return (name) => re.test(name);
    } catch {
      return () => false;
    }
  }
  // Plain patterns: case-insensitive substring, with * as a wildcard.
  const escaped = rule.pattern.trim().split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  const re = new RegExp(escaped, "i");
  return (name) => re.test(name);
}

export function listRules(db: DB): Rule[] {
  return db.prepare("SELECT * FROM rules ORDER BY position, id").all() as unknown as Rule[];
}

/** All live streams with their resolved inclusion and output fields, in output order. */
export function resolveChannels(db: DB): ChannelView[] {
  const rows = db
    .prepare(
      `SELECT s.stream_id, s.name, s.epg_channel_id, s.icon, s.category_id,
              c.name AS category_name, c.included AS category_included,
              p.enabled, p.name AS p_name, p.number AS p_number, p.group_name AS p_group, p.logo AS p_logo,
              p.epg_mode, p.epg_source_id, p.epg_channel_id AS p_epg_channel_id
       FROM streams s
       LEFT JOIN categories c ON c.category_id = s.category_id
       LEFT JOIN channel_prefs p ON p.stream_id = s.stream_id
       WHERE s.removed = 0
       ORDER BY COALESCE(c.position, 1e9), s.position`,
    )
    .all() as unknown as Row[];

  const settings = getSettings(db);
  const guideNames = settings.cleanNames ? guideDisplayNames(db) : new Map<number, string>();
  const displayName = (row: Row) => {
    if (!settings.cleanNames) return row.name;
    const cleaned = cleanChannelName(row.name);
    return isAllCaps(cleaned) ? (guideNames.get(row.stream_id) ?? cleaned) : cleaned;
  };
  const rules = listRules(db).map((r) => ({ ...r, test: compileRule(r) }));
  const appliesTo = (r: (typeof rules)[number], row: Row) =>
    (r.category_id == null || r.category_id === row.category_id) && r.test(row.name);

  const channels: ChannelView[] = rows.map((row) => {
    const excludedByRule = rules.some((r) => r.action === "exclude" && appliesTo(r, row));
    const includedByRule = rules.some((r) => r.action === "include" && appliesTo(r, row));
    let included: boolean;
    let reason: IncludeReason;
    if (row.enabled != null) {
      included = row.enabled === 1;
      reason = "manual";
    } else if (excludedByRule) {
      included = false;
      reason = "rule";
    } else if (includedByRule) {
      included = true;
      reason = "rule";
    } else {
      included = row.category_included === 1;
      reason = included ? "category" : null;
    }
    return {
      streamId: row.stream_id,
      providerName: row.name,
      epgChannelId: row.epg_channel_id,
      providerIcon: row.icon,
      categoryId: row.category_id,
      categoryName: row.category_name,
      included,
      reason,
      excludedByRule,
      enabledOverride: row.enabled == null ? null : row.enabled === 1,
      name: row.p_name?.trim() || displayName(row),
      number: null,
      numberOverride: row.p_number,
      group: row.p_group?.trim() || row.category_name || "Uncategorized",
      logo: row.p_logo?.trim() || row.icon,
      nameOverride: row.p_name,
      groupOverride: row.p_group,
      logoOverride: row.p_logo,
      epgMode: row.epg_mode === "manual" || row.epg_mode === "dummy" ? row.epg_mode : "auto",
      epgSourceId: row.epg_source_id,
      epgOverrideChannelId: row.p_epg_channel_id,
    };
  });

  assignNumbers(channels, settings.startNumber);
  return channels;
}

/** First display-name of the guide channel each stream is matched to (not placeholders or per-channel EPG). */
function guideDisplayNames(db: DB): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT ce.stream_id, ec.names FROM channel_epg ce
       JOIN epg_channels ec ON ec.source_id = ce.source_id AND ec.channel_id = ce.epg_channel_id
       WHERE ce.method IN ('tvg-id', 'name', 'manual')`,
    )
    .all() as { stream_id: number; names: string }[];
  const map = new Map<number, string>();
  for (const r of rows) {
    const first = (JSON.parse(r.names) as string[])[0]?.trim();
    if (first) map.set(r.stream_id, first);
  }
  return map;
}

/** Fixed numbers are kept; the rest count up from startNumber, skipping numbers already taken. */
function assignNumbers(channels: ChannelView[], startNumber: number) {
  const included = channels.filter((c) => c.included);
  const taken = new Set<number>();
  for (const c of included) {
    if (c.numberOverride != null) {
      c.number = c.numberOverride;
      taken.add(c.numberOverride);
    }
  }
  let next = startNumber;
  for (const c of included) {
    if (c.number != null) continue;
    while (taken.has(next)) next++;
    c.number = next;
    taken.add(next);
    next++;
  }
}

export function includedChannels(db: DB): ChannelView[] {
  return resolveChannels(db)
    .filter((c) => c.included)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

export interface ChannelPrefPatch {
  enabled?: boolean | null;
  name?: string | null;
  number?: number | null;
  group?: string | null;
  logo?: string | null;
  epgMode?: "auto" | "manual" | "dummy";
  epgSourceId?: number | null;
  epgChannelId?: string | null;
}

export function updateChannelPrefs(db: DB, streamIds: number[], patch: ChannelPrefPatch) {
  const columns: Record<keyof ChannelPrefPatch, string> = {
    enabled: "enabled",
    name: "name",
    number: "number",
    group: "group_name",
    logo: "logo",
    epgMode: "epg_mode",
    epgSourceId: "epg_source_id",
    epgChannelId: "epg_channel_id",
  };
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(columns) as [keyof ChannelPrefPatch, string][]) {
    if (!(key in patch)) continue;
    let value = patch[key] as string | number | boolean | null | undefined;
    if (typeof value === "boolean") value = value ? 1 : 0;
    if (typeof value === "string" && value.trim() === "") value = null;
    if (key === "epgMode" && value === "auto") value = null;
    sets.push(`${column} = ?`);
    values.push(value ?? null);
  }
  if (!sets.length) return;
  const insert = db.prepare("INSERT OR IGNORE INTO channel_prefs (stream_id) VALUES (?)");
  const update = db.prepare(`UPDATE channel_prefs SET ${sets.join(", ")} WHERE stream_id = ?`);
  for (const id of streamIds) {
    insert.run(id);
    update.run(...values, id);
  }
}
