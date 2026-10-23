import fs from "node:fs";
import zlib from "node:zlib";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { config } from "./config.js";
import { getSetting, type DB } from "./db.js";
import { listRules, resolveChannels, updateChannelPrefs, type ChannelPrefPatch, type ChannelView } from "./filter/channels.js";
import { guideFile } from "./epg/refresh.js";
import {
  SESSION_COOKIE, createSession, deleteSession, hasAdminPassword, setAdminPassword, validSession, verifyAdminPassword,
} from "./lib/auth.js";
import { jobState } from "./lib/jobs.js";
import { scheduleEpgRebuild, startEpgRefresh, startPlaylistSync } from "./lib/scheduler.js";
import { buildM3u, buildXmltv, outputUrls } from "./output/export.js";
import { getOutputToken, getSettings, regenerateOutputToken, updateSettings, type AppSettings } from "./settings.js";
import { XtreamClient, redact } from "./xtream/client.js";
import { getClient, getSource, publicSource, saveSource, type SourceInput } from "./xtream/source.js";

export function buildApp(db: DB, opts: { logger?: boolean; serveWeb?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ? { level: "info", redact: ["req.headers.cookie"], serializers: { req: reqSerializer } } : false,
    trustProxy: true,
  });
  app.register(cookie);

  const baseUrl = (req: FastifyRequest) => config.publicUrl ?? `${req.protocol}://${req.headers.host}`;
  const urlsFor = (req: FastifyRequest) =>
    outputUrls(baseUrl(req), getOutputToken(db), getSource(db)?.stream_format ?? "ts");
  const tokenOk = (token: string) => token === getOutputToken(db);

  // ---------- Output for Jellyfin (token in the path, no login) ----------

  app.get<{ Params: { token: string } }>("/o/:token/playlist.m3u", async (req, reply) => {
    if (!tokenOk(req.params.token)) return reply.code(404).send("Not found");
    reply.header("Content-Type", "audio/x-mpegurl; charset=utf-8").header("Cache-Control", "no-store");
    return buildM3u(db, urlsFor(req));
  });

  app.get<{ Params: { token: string } }>("/o/:token/epg.xml", async (req, reply) => {
    if (!tokenOk(req.params.token)) return reply.code(404).send("Not found");
    reply.header("Content-Type", "application/xml; charset=utf-8").header("Cache-Control", "no-store");
    return buildXmltv(db);
  });

  app.get<{ Params: { token: string } }>("/o/:token/epg.xml.gz", async (req, reply) => {
    if (!tokenOk(req.params.token)) return reply.code(404).send("Not found");
    reply.header("Content-Type", "application/gzip").header("Cache-Control", "no-store");
    return zlib.gzipSync(buildXmltv(db));
  });

  // The stream link Jellyfin plays: a redirect straight to the provider, never proxied.
  const redirectStream = async (req: FastifyRequest<{ Params: { token: string; file: string } }>, reply: FastifyReply) => {
    if (!tokenOk(req.params.token)) return reply.code(404).send("Not found");
    const m = /^(\d+)(?:\.(ts|m3u8))?$/.exec(req.params.file);
    const client = getClient(db);
    if (!m || !client) return reply.code(404).send("Not found");
    const streamId = Number(m[1]);
    const exists = db.prepare("SELECT 1 FROM streams WHERE stream_id = ? AND removed = 0").get(streamId);
    if (!exists) return reply.code(404).send("Unknown channel");
    const format = (m[2] as "ts" | "m3u8" | undefined) ?? getSource(db)?.stream_format ?? "ts";
    return reply.header("Cache-Control", "no-store").redirect(client.streamUrl(streamId, format), 302);
  };
  app.get("/s/:token/:file", redirectStream); // Fastify adds the matching HEAD route

  // ---------- Auth ----------

  app.get("/api/auth/state", async (req) => ({
    setupRequired: !hasAdminPassword(db),
    authenticated: validSession(db, req.cookies[SESSION_COOKIE]),
  }));

  const startSession = (reply: FastifyReply, req: FastifyRequest) => {
    const { token, maxAge } = createSession(db);
    reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", maxAge, secure: req.protocol === "https" });
  };

  app.post<{ Body: { password?: string } }>("/api/auth/setup", async (req, reply) => {
    if (hasAdminPassword(db)) return reply.code(409).send({ error: "Already set up" });
    setAdminPassword(db, String(req.body?.password ?? ""));
    startSession(reply, req);
    return { ok: true };
  });

  app.post<{ Body: { password?: string } }>("/api/auth/login", async (req, reply) => {
    await new Promise((r) => setTimeout(r, 300)); // slow down guessing
    if (!verifyAdminPassword(db, String(req.body?.password ?? ""))) return reply.code(401).send({ error: "Wrong password" });
    startSession(reply, req);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    deleteSession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/auth/")) return;
    if (!validSession(db, req.cookies[SESSION_COOKIE])) return reply.code(401).send({ error: "Not logged in" });
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 400;
    reply.code(status).send({ error: redact(err.message) });
  });

  // ---------- Status ----------

  app.get("/api/status", async (req) => {
    const all = resolveChannels(db);
    const coverage = db.prepare("SELECT method, COUNT(*) AS n FROM channel_epg GROUP BY method").all() as { method: string; n: number }[];
    const urls = urlsFor(req);
    return {
      source: publicSource(getSource(db)),
      jobs: jobState(),
      counts: {
        streams: all.length,
        included: all.filter((c) => c.included).length,
        categories: (db.prepare("SELECT COUNT(*) AS n FROM categories WHERE removed = 0").get() as { n: number }).n,
      },
      epg: {
        coverage: Object.fromEntries(coverage.map((c) => [c.method, c.n])),
        lastDownload: Number(getSetting(db, "last_epg_download") ?? 0) || null,
        lastRebuild: Number(getSetting(db, "last_epg_rebuild") ?? 0) || null,
      },
      output: { playlist: urls.playlist, epg: urls.epg, epgGz: urls.epgGz },
    };
  });

  // ---------- Source ----------

  const clientFor = (body: SourceInput) => {
    const password = body.password || getSource(db)?.password;
    if (!body.serverUrl || !body.username || !password) throw new Error("Server URL, username and password are required");
    return new XtreamClient({ serverUrl: body.serverUrl, username: body.username, password, userAgent: body.userAgent });
  };

  app.post<{ Body: SourceInput }>("/api/source/test", async (req) => ({ account: await clientFor(req.body).account() }));

  app.put<{ Body: SourceInput }>("/api/source", async (req) => {
    const account = await clientFor(req.body).account();
    saveSource(db, req.body, account);
    void startPlaylistSync(db).then(() => startEpgRefresh(db));
    return { source: publicSource(getSource(db)) };
  });

  app.post("/api/sync/playlist", async () => {
    void startPlaylistSync(db);
    return { jobs: jobState() };
  });

  app.post("/api/sync/epg", async () => {
    void startEpgRefresh(db);
    return { jobs: jobState() };
  });

  // ---------- Categories ----------

  app.get("/api/categories", async () => {
    const counts = new Map<string, { total: number; included: number }>();
    for (const c of resolveChannels(db)) {
      const key = c.categoryId ?? "";
      const entry = counts.get(key) ?? { total: 0, included: 0 };
      entry.total++;
      if (c.included) entry.included++;
      counts.set(key, entry);
    }
    const rows = db.prepare("SELECT category_id, name, included FROM categories WHERE removed = 0 ORDER BY position").all() as {
      category_id: string;
      name: string;
      included: number;
    }[];
    return rows.map((r) => ({
      id: r.category_id,
      name: r.name,
      included: r.included === 1,
      total: counts.get(r.category_id)?.total ?? 0,
      includedCount: counts.get(r.category_id)?.included ?? 0,
    }));
  });

  app.put<{ Params: { id: string }; Body: { included: boolean; resetChannels?: boolean } }>("/api/categories/:id", async (req) => {
    db.prepare("UPDATE categories SET included = ? WHERE category_id = ?").run(req.body.included ? 1 : 0, req.params.id);
    if (req.body.resetChannels) {
      db.prepare("UPDATE channel_prefs SET enabled = NULL WHERE stream_id IN (SELECT stream_id FROM streams WHERE category_id = ?)").run(
        req.params.id,
      );
    }
    scheduleEpgRebuild(db);
    return { ok: true };
  });

  // ---------- Channels ----------

  interface ChannelQuery {
    category?: string;
    q?: string;
    show?: "all" | "included" | "excluded";
    /** Comma-separated guide methods, e.g. "dummy,short-epg" for the EPG fix-it list. */
    epg?: string;
  }

  const filterChannels = (all: ChannelView[], q: ChannelQuery) => {
    const needle = q.q?.trim().toLowerCase();
    const methods = q.epg ? new Set(q.epg.split(",")) : null;
    const methodOf = methods
      ? new Map(
          (db.prepare("SELECT stream_id, method FROM channel_epg").all() as { stream_id: number; method: string }[]).map((r) => [
            r.stream_id,
            r.method,
          ]),
        )
      : null;
    return all.filter(
      (c) =>
        (!q.category || c.categoryId === q.category) &&
        (!needle || c.name.toLowerCase().includes(needle) || c.providerName.toLowerCase().includes(needle)) &&
        (q.show === "included" ? c.included : q.show === "excluded" ? !c.included : true) &&
        (!methods || (c.included && methods.has(methodOf!.get(c.streamId) ?? "dummy"))),
    );
  };

  app.get<{ Querystring: ChannelQuery & { page?: string; pageSize?: string } }>("/api/channels", async (req) => {
    const all = filterChannels(resolveChannels(db), req.query);
    if (req.query.show === "included") all.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize ?? 100)));
    const page = Math.max(0, Number(req.query.page ?? 0));
    const items = all.slice(page * pageSize, (page + 1) * pageSize);
    return { total: all.length, page, pageSize, items: withEpgInfo(db, items) };
  });

  app.patch<{ Body: { streamIds?: number[]; filter?: ChannelQuery; patch: ChannelPrefPatch } }>("/api/channels", async (req) => {
    const ids = req.body.streamIds?.length
      ? req.body.streamIds.map(Number)
      : req.body.filter
        ? filterChannels(resolveChannels(db), req.body.filter).map((c) => c.streamId)
        : [];
    updateChannelPrefs(db, ids, req.body.patch ?? {});
    scheduleEpgRebuild(db);
    return { updated: ids.length };
  });

  // ---------- Rules ----------

  app.get("/api/rules", async () => listRules(db));

  app.post<{ Body: { action: "include" | "exclude"; pattern: string; isRegex?: boolean; categoryId?: string | null } }>(
    "/api/rules",
    async (req) => {
      const { action, pattern, isRegex, categoryId } = req.body;
      if (!pattern?.trim()) throw new Error("Pattern is required");
      if (isRegex) new RegExp(pattern); // throws a readable error for bad patterns
      const r = db
        .prepare("INSERT INTO rules (action, pattern, is_regex, category_id, position) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM rules))")
        .run(action === "exclude" ? "exclude" : "include", pattern.trim(), isRegex ? 1 : 0, categoryId || null);
      scheduleEpgRebuild(db);
      return { id: Number(r.lastInsertRowid) };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/rules/:id", async (req) => {
    db.prepare("DELETE FROM rules WHERE id = ?").run(Number(req.params.id));
    scheduleEpgRebuild(db);
    return { ok: true };
  });

  // ---------- EPG ----------

  app.get("/api/epg/sources", async () =>
    db.prepare("SELECT * FROM epg_sources ORDER BY CASE kind WHEN 'xtream' THEN 0 ELSE 1 END, priority, id").all(),
  );

  app.post<{ Body: { name?: string; url: string } }>("/api/epg/sources", async (req) => {
    const url = new URL(req.body.url).toString();
    const r = db
      .prepare("INSERT INTO epg_sources (kind, name, url, priority) VALUES ('xmltv', ?, ?, (SELECT COALESCE(MAX(priority), 0) + 1 FROM epg_sources))")
      .run(req.body.name?.trim() || new URL(url).hostname, url);
    void startEpgRefresh(db);
    return { id: Number(r.lastInsertRowid) };
  });

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; name?: string; url?: string } }>("/api/epg/sources/:id", async (req) => {
    const id = Number(req.params.id);
    if (req.body.enabled != null) db.prepare("UPDATE epg_sources SET enabled = ? WHERE id = ?").run(req.body.enabled ? 1 : 0, id);
    if (req.body.name) db.prepare("UPDATE epg_sources SET name = ? WHERE id = ?").run(req.body.name.trim(), id);
    if (req.body.url) db.prepare("UPDATE epg_sources SET url = ? WHERE id = ? AND kind = 'xmltv'").run(new URL(req.body.url).toString(), id);
    scheduleEpgRebuild(db);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/epg/sources/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const row = db.prepare("SELECT kind FROM epg_sources WHERE id = ?").get(id) as { kind: string } | undefined;
    if (!row) return reply.code(404).send({ error: "Not found" });
    if (row.kind === "xtream") return reply.code(400).send({ error: "The provider guide can be disabled, not removed" });
    db.prepare("DELETE FROM epg_sources WHERE id = ?").run(id);
    db.prepare("DELETE FROM epg_channels WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM programmes WHERE source_id = ?").run(id);
    db.prepare("UPDATE channel_prefs SET epg_mode = NULL, epg_source_id = NULL, epg_channel_id = NULL WHERE epg_source_id = ?").run(id);
    fs.rmSync(guideFile(id), { force: true });
    scheduleEpgRebuild(db);
    return { ok: true };
  });

  /** Guide channels for the manual picker. */
  app.get<{ Querystring: { q?: string; sourceId?: string } }>("/api/epg/channels", async (req) => {
    const q = `%${(req.query.q ?? "").trim()}%`;
    const params: (string | number)[] = [q, q];
    let where = "(ec.channel_id LIKE ? OR ec.names LIKE ?)";
    if (req.query.sourceId) {
      where += " AND ec.source_id = ?";
      params.push(Number(req.query.sourceId));
    }
    return db
      .prepare(
        `SELECT ec.source_id AS sourceId, s.name AS sourceName, ec.channel_id AS channelId, ec.names, ec.icon
         FROM epg_channels ec JOIN epg_sources s ON s.id = ec.source_id
         WHERE ${where} ORDER BY s.priority, ec.channel_id LIMIT 50`,
      )
      .all(...params)
      .map((r) => ({ ...(r as object), names: JSON.parse((r as { names: string }).names) }));
  });

  app.get<{ Querystring: { streamId: string } }>("/api/epg/programmes", async (req) => {
    const m = db.prepare("SELECT source_id, epg_channel_id, method FROM channel_epg WHERE stream_id = ?").get(Number(req.query.streamId)) as
      | { source_id: number | null; epg_channel_id: string | null; method: string }
      | undefined;
    if (!m?.epg_channel_id || m.source_id == null) return { method: m?.method ?? "dummy", programmes: [] };
    const now = Math.floor(Date.now() / 1000);
    const programmes = db
      .prepare("SELECT start, stop, title, sub_title AS subTitle, description FROM programmes WHERE source_id = ? AND channel_id = ? AND stop > ? ORDER BY start LIMIT 30")
      .all(m.source_id, m.epg_channel_id, now);
    return { method: m.method, programmes };
  });

  // ---------- Settings / output ----------

  app.get("/api/settings", async () => getSettings(db));
  app.put<{ Body: Partial<AppSettings> }>("/api/settings", async (req) => {
    const s = updateSettings(db, req.body ?? {});
    scheduleEpgRebuild(db);
    return s;
  });

  app.post("/api/output/regenerate-token", async (req) => {
    regenerateOutputToken(db);
    const urls = urlsFor(req);
    return { playlist: urls.playlist, epg: urls.epg, epgGz: urls.epgGz };
  });

  // ---------- Web UI ----------

  if (opts.serveWeb !== false && fs.existsSync(config.webDir)) {
    app.register(fastifyStatic, { root: config.webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/o/") || req.url.startsWith("/s/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

/** Adds what is playing now to a page of channels. */
function withEpgInfo(db: DB, items: ChannelView[]) {
  const now = Math.floor(Date.now() / 1000);
  const mapping = db.prepare("SELECT source_id, epg_channel_id, method, programme_count FROM channel_epg WHERE stream_id = ?");
  const current = db.prepare(
    "SELECT title, start, stop FROM programmes WHERE source_id = ? AND channel_id = ? AND start <= ? AND stop > ? LIMIT 1",
  );
  return items.map((c) => {
    const m = mapping.get(c.streamId) as
      | { source_id: number | null; epg_channel_id: string | null; method: string; programme_count: number }
      | undefined;
    const nowPlaying =
      m?.source_id != null && m.epg_channel_id ? (current.get(m.source_id, m.epg_channel_id, now, now) as { title: string } | undefined) : undefined;
    return {
      ...c,
      epg: m ? { method: m.method, sourceId: m.source_id, channelId: m.epg_channel_id, programmes: m.programme_count } : null,
      nowPlaying: nowPlaying?.title ?? null,
    };
  });
}

/** Log lines must never contain the output token or provider credentials. */
function reqSerializer(req: { method: string; url: string }) {
  return { method: req.method, url: req.url.replace(/\/(o|s)\/[0-9a-f]{32}\//, "/$1/***/") };
}
