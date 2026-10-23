import path from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 9292),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir: path.resolve(process.env.DATA_DIR ?? "/data"),
  /** Base URL written into the M3U/EPG links. Falls back to the request's Host header. */
  publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, "") || undefined,
  webDir: path.resolve(process.env.WEB_DIR ?? path.join(import.meta.dirname, "../../web/dist")),
};

export const epgCacheDir = () => path.join(config.dataDir, "epg");
