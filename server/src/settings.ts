import crypto from "node:crypto";
import { getSetting, setSetting, type DB } from "./db.js";

export interface AppSettings {
  /** Hours between playlist syncs. */
  playlistRefreshHours: number;
  /** Hours between EPG downloads. */
  epgRefreshHours: number;
  /** Days of guide data to export. */
  epgDays: number;
  /** Days of past guide data to keep in the export (for "earlier today"). */
  epgPastDays: number;
  /** First number used when auto-numbering channels. */
  startNumber: number;
  /** Fetch get_simple_data_table for included channels the XMLTV doesn't cover. */
  shortEpgFallback: boolean;
  /** Cap on per-channel EPG requests per refresh, to stay polite to the provider. */
  shortEpgMaxChannels: number;
  /** Length of placeholder programmes for channels without guide data, in minutes. */
  dummyBlockMinutes: number;
  /** Strip country prefixes and quality suffixes from channel names, and use the guide's spelling for ALL-CAPS names. */
  cleanNames: boolean;
}

export const defaultSettings: AppSettings = {
  playlistRefreshHours: 12,
  epgRefreshHours: 6,
  epgDays: 3,
  epgPastDays: 1,
  startNumber: 1,
  shortEpgFallback: true,
  shortEpgMaxChannels: 300,
  dummyBlockMinutes: 120,
  cleanNames: true,
};

export function getSettings(db: DB): AppSettings {
  const raw = getSetting(db, "app");
  return { ...defaultSettings, ...(raw ? (JSON.parse(raw) as Partial<AppSettings>) : {}) };
}

export function updateSettings(db: DB, patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(db) };
  for (const key of Object.keys(defaultSettings) as (keyof AppSettings)[]) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (typeof value !== typeof defaultSettings[key]) throw new Error(`Invalid value for ${key}`);
    (next as Record<string, unknown>)[key] = value;
  }
  next.epgDays = clamp(next.epgDays, 1, 14);
  next.epgPastDays = clamp(next.epgPastDays, 0, 3);
  next.playlistRefreshHours = clamp(next.playlistRefreshHours, 1, 168);
  next.epgRefreshHours = clamp(next.epgRefreshHours, 1, 168);
  next.shortEpgMaxChannels = clamp(next.shortEpgMaxChannels, 0, 5000);
  next.dummyBlockMinutes = clamp(next.dummyBlockMinutes, 15, 720);
  setSetting(db, "app", JSON.stringify(next));
  return next;
}

/** Secret in the M3U/EPG/stream URLs. Jellyfin can't send auth headers, so the path is the credential. */
export function getOutputToken(db: DB): string {
  let token = getSetting(db, "output_token");
  if (!token) token = regenerateOutputToken(db);
  return token;
}

export function regenerateOutputToken(db: DB): string {
  const token = crypto.randomBytes(16).toString("hex");
  setSetting(db, "output_token", token);
  return token;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));
