export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

export const get = <T>(url: string) => api<T>("GET", url);

export interface Account {
  status?: string;
  exp_date?: string | null;
  max_connections?: string | number;
  active_cons?: string | number;
  is_trial?: string | number;
  server_timezone?: string;
}

export interface Source {
  serverUrl: string;
  username: string;
  hasPassword: boolean;
  userAgent: string | null;
  streamFormat: "ts" | "m3u8";
  account: Account | null;
  lastSyncAt: number | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
}

export type JobName = "playlist" | "epg" | "epg-rebuild";

export interface Status {
  source: Source | null;
  jobs: {
    running: JobName | null;
    step: string | null;
    startedAt: number | null;
    last: Partial<Record<JobName, { finishedAt: number; ok: boolean; message: string }>>;
  };
  counts: { streams: number; included: number; categories: number };
  epg: { coverage: Partial<Record<EpgMethod, number>>; lastDownload: number | null; lastRebuild: number | null };
  output: { playlist: string; epg: string; epgGz: string };
}

export interface Category {
  id: string;
  name: string;
  included: boolean;
  total: number;
  includedCount: number;
}

export type EpgMethod = "manual" | "tvg-id" | "name" | "short-epg" | "dummy";

export interface Channel {
  streamId: number;
  providerName: string;
  epgChannelId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  included: boolean;
  reason: "manual" | "rule" | "category" | null;
  enabledOverride: boolean | null;
  name: string;
  number: number | null;
  numberOverride: number | null;
  group: string;
  logo: string | null;
  nameOverride: string | null;
  groupOverride: string | null;
  epgMode: "auto" | "manual" | "dummy";
  epg: { method: EpgMethod; sourceId: number | null; channelId: string | null; programmes: number } | null;
  nowPlaying: string | null;
}

export interface ChannelPage {
  total: number;
  page: number;
  pageSize: number;
  items: Channel[];
}

export interface ChannelPatch {
  enabled?: boolean | null;
  name?: string | null;
  number?: number | null;
  group?: string | null;
  logo?: string | null;
  epgMode?: "auto" | "manual" | "dummy";
  epgSourceId?: number | null;
  epgChannelId?: string | null;
}

export interface Rule {
  id: number;
  action: "include" | "exclude";
  pattern: string;
  is_regex: number;
  category_id: string | null;
}

export interface EpgSource {
  id: number;
  kind: "xtream" | "xmltv";
  name: string;
  url: string | null;
  enabled: number;
  last_fetch_at: number | null;
  status: string | null;
  error: string | null;
  channel_count: number;
  programme_count: number;
}

export interface GuideChannel {
  sourceId: number;
  sourceName: string;
  channelId: string;
  names: string[];
  icon: string | null;
}

export interface Settings {
  playlistRefreshHours: number;
  epgRefreshHours: number;
  epgDays: number;
  epgPastDays: number;
  startNumber: number;
  shortEpgFallback: boolean;
  shortEpgMaxChannels: number;
  dummyBlockMinutes: number;
  cleanNames: boolean;
}

export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
