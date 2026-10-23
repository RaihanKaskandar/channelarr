import { Readable } from "node:stream";

export const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export interface XtreamCredentials {
  serverUrl: string;
  username: string;
  password: string;
  userAgent?: string | null;
}

export interface XtreamAccount {
  auth: number;
  status?: string;
  exp_date?: string | null;
  max_connections?: string | number;
  active_cons?: string | number;
  is_trial?: string | number;
  created_at?: string;
  allowed_output_formats?: string[];
  server_timezone?: string;
}

export interface XtreamCategory {
  category_id: string;
  category_name: string;
  parent_id?: number;
}

export interface XtreamLiveStream {
  num?: number;
  name: string;
  stream_type?: string;
  stream_id: number;
  stream_icon?: string | null;
  epg_channel_id?: string | null;
  category_id?: string | null;
  category_ids?: number[];
  tv_archive?: number;
}

export interface XtreamEpgListing {
  title: string;
  description: string;
  start_timestamp: number;
  stop_timestamp: number;
  lang?: string;
}

export class XtreamError extends Error {}

/**
 * Accepts what people paste ("host:port", "http://host/", ".../player_api.php?...", ".../get.php?...")
 * and returns "scheme://host[:port]" plus any base path the panel lives under.
 */
export function normalizeServerUrl(input: string): string {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  const url = new URL(raw);
  let pathname = url.pathname.replace(/\/(player_api|get|xmltv|panel_api)\.php$/i, "").replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

export class XtreamClient {
  readonly serverUrl: string;
  private readonly username: string;
  private readonly password: string;
  readonly userAgent: string;

  constructor(creds: XtreamCredentials) {
    this.serverUrl = normalizeServerUrl(creds.serverUrl);
    this.username = creds.username;
    this.password = creds.password;
    this.userAgent = creds.userAgent?.trim() || DEFAULT_USER_AGENT;
  }

  private apiUrl(params: Record<string, string | number> = {}) {
    const url = new URL(`${this.serverUrl}/player_api.php`);
    url.searchParams.set("username", this.username);
    url.searchParams.set("password", this.password);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return url.toString();
  }

  xmltvUrl(): string {
    const url = new URL(`${this.serverUrl}/xmltv.php`);
    url.searchParams.set("username", this.username);
    url.searchParams.set("password", this.password);
    return url.toString();
  }

  streamUrl(streamId: number, format: "ts" | "m3u8" = "ts"): string {
    const u = encodeURIComponent(this.username);
    const p = encodeURIComponent(this.password);
    return `${this.serverUrl}/live/${u}/${p}/${streamId}.${format}`;
  }

  private async getJson<T>(params: Record<string, string | number>, timeoutMs = 60_000): Promise<T> {
    const text = await fetchText(this.apiUrl(params), this.userAgent, timeoutMs);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new XtreamError(`Provider returned invalid JSON for ${params.action ?? "login"}: ${text.slice(0, 120)}`);
    }
  }

  async account(): Promise<XtreamAccount> {
    const data = await this.getJson<{ user_info?: XtreamAccount; server_info?: { timezone?: string } }>({}, 30_000);
    if (!data?.user_info || Number(data.user_info.auth) !== 1) {
      throw new XtreamError("Login failed: the provider rejected these credentials");
    }
    return { ...data.user_info, server_timezone: data.server_info?.timezone };
  }

  async liveCategories(): Promise<XtreamCategory[]> {
    const data = await this.getJson<XtreamCategory[] | null>({ action: "get_live_categories" });
    return Array.isArray(data) ? data : [];
  }

  async liveStreams(): Promise<XtreamLiveStream[]> {
    const data = await this.getJson<XtreamLiveStream[] | null>({ action: "get_live_streams" }, 180_000);
    return Array.isArray(data) ? data : [];
  }

  /** Full listing for one channel. Titles and descriptions come base64-encoded on most panels. */
  async channelEpg(streamId: number): Promise<XtreamEpgListing[]> {
    type Raw = { title?: string; description?: string; start_timestamp?: string | number; stop_timestamp?: string | number; lang?: string };
    let data = await this.getJson<{ epg_listings?: Raw[] }>({ action: "get_simple_data_table", stream_id: streamId }, 30_000);
    if (!data?.epg_listings?.length) {
      data = await this.getJson<{ epg_listings?: Raw[] }>({ action: "get_short_epg", stream_id: streamId, limit: 100 }, 30_000);
    }
    return (data?.epg_listings ?? [])
      .map((l) => ({
        title: decodeMaybeBase64(l.title ?? ""),
        description: decodeMaybeBase64(l.description ?? ""),
        start_timestamp: Number(l.start_timestamp),
        stop_timestamp: Number(l.stop_timestamp),
        lang: l.lang,
      }))
      .filter((l) => l.title && Number.isFinite(l.start_timestamp) && l.stop_timestamp > l.start_timestamp);
  }

  /** Streams the provider's full XMLTV guide. */
  async openXmltv(timeoutMs = 600_000): Promise<Readable> {
    return openStream(this.xmltvUrl(), this.userAgent, timeoutMs);
  }
}

export async function fetchText(url: string, userAgent: string, timeoutMs: number): Promise<string> {
  const res = await fetchWithRetry(url, userAgent, timeoutMs);
  return res.text();
}

export async function openStream(url: string, userAgent: string, timeoutMs: number): Promise<Readable> {
  const res = await fetchWithRetry(url, userAgent, timeoutMs);
  if (!res.body) throw new XtreamError("Empty response body");
  return Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
}

async function fetchWithRetry(url: string, userAgent: string, timeoutMs: number, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": userAgent, Accept: "*/*" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if (res.status >= 500 || res.status === 429) {
        lastError = new XtreamError(`Provider responded ${res.status}`);
      } else if (!res.ok) {
        throw new XtreamError(`Provider responded ${res.status} ${res.statusText}`);
      } else {
        return res;
      }
    } catch (err) {
      if (err instanceof XtreamError) throw err;
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  throw lastError instanceof Error ? new XtreamError(redact(lastError.message)) : new XtreamError("Request failed");
}

/** Keep credentials out of error messages and logs. */
export function redact(text: string): string {
  return text
    .replace(/(username|password)=[^&\s"']*/gi, "$1=***")
    .replace(/\/live\/[^/\s]+\/[^/\s]+\//g, "/live/***/***/");
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function decodeMaybeBase64(value: string): string {
  const v = value.trim();
  if (v.length < 4 || v.length % 4 !== 0 || !BASE64_RE.test(v)) return v;
  const decoded = Buffer.from(v, "base64").toString("utf8");
  // Plain words like "News" are valid base64 too; only accept output that looks like text.
  if (decoded.includes("�") || /[\x00-\x08\x0E-\x1F]/.test(decoded)) return v;
  return decoded.trim();
}
