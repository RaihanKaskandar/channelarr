import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openMemoryDb, type DB } from "../src/db.js";
import { refreshEpg } from "../src/epg/refresh.js";
import { jobState } from "../src/lib/jobs.js";
import { getOutputToken } from "../src/settings.js";
import { MOCK_PASS, MOCK_USER, startMockXtream } from "./mock-xtream.js";

let mock: Awaited<ReturnType<typeof startMockXtream>>;
let db: DB;
let app: ReturnType<typeof buildApp>;
let cookie = "";

const api = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? res.json() : res.body, res };
};

async function waitForJobs() {
  for (let i = 0; i < 200; i++) {
    const s = jobState();
    if (!s.running && s.last.epg) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`jobs did not finish: ${JSON.stringify(jobState())}`);
}

beforeAll(async () => {
  mock = await startMockXtream();
  db = openMemoryDb();
  app = buildApp(db, { serveWeb: false });
});

afterAll(async () => {
  await app.close();
  await mock.close();
});

describe("Channelarr end to end", () => {
  it("requires login for the API", async () => {
    expect((await api("GET", "/api/status")).status).toBe(401);
    const state = await api("GET", "/api/auth/state");
    expect(state.body).toEqual({ setupRequired: true, authenticated: false });
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: "correct horse" } });
    expect(setup.statusCode).toBe(200);
    cookie = String(setup.headers["set-cookie"]).split(";")[0];
    expect((await api("GET", "/api/status")).status).toBe(200);
  });

  it("rejects bad provider credentials without saving them", async () => {
    const r = await api("PUT", "/api/source", { serverUrl: mock.url, username: MOCK_USER, password: "wrong" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/rejected/);
    expect((await api("GET", "/api/status")).body.source).toBeNull();
  });

  it("saves the source, syncs the playlist and downloads the guide", async () => {
    const r = await api("PUT", "/api/source", { serverUrl: `${mock.url}/player_api.php`, username: MOCK_USER, password: MOCK_PASS });
    expect(r.status).toBe(200);
    expect(r.body.source).toMatchObject({ serverUrl: mock.url, hasPassword: true });
    expect(JSON.stringify(r.body)).not.toContain(MOCK_PASS);
    await waitForJobs();
    expect(jobState().last.playlist?.ok).toBe(true);
    expect(jobState().last.epg?.ok).toBe(true);
    const cats = await api("GET", "/api/categories");
    expect(cats.body.map((c: { name: string; total: number }) => `${c.name}:${c.total}`)).toEqual(["UK | General:2", "DE | General:3"]);
  });

  it("builds an EPG for every included channel", async () => {
    await api("PUT", "/api/categories/1", { included: true });
    await api("PUT", "/api/categories/2", { included: true });
    await api("PATCH", "/api/channels", { streamIds: [201], patch: { name: "Das Erste" } });
    const summary = await refreshEpg(db, { download: false });
    expect(summary).toBe("5 channels: 3 from guides, 1 from per-channel EPG, 1 placeholder");

    const coverage = db.prepare("SELECT stream_id, method FROM channel_epg ORDER BY stream_id").all();
    expect(coverage).toEqual([
      { stream_id: 101, method: "tvg-id" },
      { stream_id: 102, method: "tvg-id" },
      { stream_id: 201, method: "name" },
      { stream_id: 202, method: "short-epg" },
      { stream_id: 203, method: "dummy" },
    ]);
    // Only programmes for guide channels in use are stored.
    const stored = db.prepare("SELECT DISTINCT channel_id FROM programmes WHERE source_id > 0 ORDER BY channel_id").all();
    expect(stored).toEqual([{ channel_id: "BBCOne.uk" }, { channel_id: "das.erste.de" }]);
  });

  it("exports an M3U whose tvg-ids all exist in the EPG", async () => {
    const token = getOutputToken(db);
    const m3u = await app.inject({ url: `/o/${token}/playlist.m3u`, headers: { host: "channelarr.local:9292" } });
    expect(m3u.statusCode).toBe(200);
    const lines = m3u.body.trim().split("\n");
    expect(lines[0]).toBe(
      `#EXTM3U x-tvg-url="http://channelarr.local:9292/o/${token}/epg.xml" url-tvg="http://channelarr.local:9292/o/${token}/epg.xml"`,
    );
    expect(lines).toContain(
      '#EXTINF:-1 tvg-id="ch201" tvg-name="Das Erste" tvg-logo="" tvg-chno="3" group-title="DE | General",Das Erste',
    );
    expect(lines).toContain(`http://channelarr.local:9292/s/${token}/101.ts`);
    expect(m3u.body).not.toContain(MOCK_PASS);

    const epg = await app.inject({ url: `/o/${token}/epg.xml` });
    const tvgIds = [...m3u.body.matchAll(/tvg-id="([^"]+)"/g)].map((m) => m[1]);
    const epgIds = [...epg.body.matchAll(/<channel id="([^"]+)">/g)].map((m) => m[1]);
    expect(tvgIds).toHaveLength(5);
    expect(new Set(epgIds)).toEqual(new Set(tvgIds));
    for (const id of tvgIds) expect(epg.body).toContain(`channel="${id}"`);

    expect(epg.body).toContain("<title>News at Six &amp; Weather</title>");
    expect(epg.body).toContain("<desc>Headlines tonight.</desc>"); // &nbsp; is defined and collapsed
    expect(epg.body).toContain('<episode-num system="xmltv_ns">1.4.</episode-num>');
    expect(epg.body).toContain("<title>Mystery Hour</title>");
    expect(epg.body).toContain("<title>Silent Channel</title>"); // cleaned name, placeholder guide
    expect(m3u.body).toContain('tvg-id="ch101" tvg-name="BBC One"');
    expect(epg.body).toContain('<icon src="http://img.example/bbc1.png" />'); // guide icon fills a missing logo
    expect(epg.body).not.toContain("Should not be stored");

    const gz = await app.inject({ url: `/o/${token}/epg.xml.gz` });
    expect(gz.headers["content-type"]).toBe("application/gzip");
  });

  it("clips overlapping guide programmes", async () => {
    const epg = (await app.inject({ url: `/o/${getOutputToken(db)}/epg.xml` })).body;
    const t = (unix: number) => new Date(unix * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14);
    expect(epg).toContain(`start="${t(mock.times.T1)} +0000" stop="${t(mock.times.T2)} +0000" channel="ch201"`);
  });

  it("redirects streams to the provider instead of proxying them", async () => {
    const token = getOutputToken(db);
    const r = await app.inject({ url: `/s/${token}/101.ts` });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`${mock.url}/live/${MOCK_USER}/${MOCK_PASS}/101.ts`);
    expect((await app.inject({ method: "HEAD", url: `/s/${token}/101.ts` })).statusCode).toBe(302);
    expect((await app.inject({ url: `/s/${token}/101.m3u8` })).headers.location).toMatch(/\/101\.m3u8$/);
    expect((await app.inject({ url: `/s/${token}/999.ts` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/s/${"0".repeat(32)}/101.ts` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/o/${"0".repeat(32)}/playlist.m3u` })).statusCode).toBe(404);
  });

  it("applies exclude rules and manual toggles", async () => {
    await api("POST", "/api/rules", { action: "exclude", pattern: "silent" });
    await api("PATCH", "/api/channels", { streamIds: [102], patch: { enabled: false } });
    const list = await api("GET", "/api/channels?show=included");
    expect(list.body.items.map((c: { streamId: number; number: number }) => `${c.streamId}#${c.number}`)).toEqual(["101#1", "201#2", "202#3"]);
    expect(list.body.items[0].nowPlaying).toBe("News at Six & Weather");
  });

  it("supports manual EPG mapping", async () => {
    await api("PATCH", "/api/channels", { streamIds: [202], patch: { epgMode: "manual", epgSourceId: 1, epgChannelId: "BBCOne.uk" } });
    await refreshEpg(db, { download: false });
    const row = db.prepare("SELECT method, epg_channel_id FROM channel_epg WHERE stream_id = 202").get();
    expect(row).toEqual({ method: "manual", epg_channel_id: "BBCOne.uk" });
    const picker = await api("GET", "/api/epg/channels?q=erste");
    expect(picker.body[0]).toMatchObject({ channelId: "das.erste.de", names: ["Das Erste"] });
  });
});
