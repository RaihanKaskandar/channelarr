import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import zlib from "node:zlib";

export const MOCK_USER = "user";
export const MOCK_PASS = "pass";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const xmltvTime = (unix: number) => new Date(unix * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14);

/** A tiny Xtream Codes panel: login, categories, live streams, per-channel EPG and a gzipped xmltv.php. */
export async function startMockXtream() {
  const hour = Math.floor(Date.now() / 3_600_000) * 3600;
  const times = { T0: hour, T1: hour + 3600, T2: hour + 7200, T3: hour + 10800 };
  let guide = fs.readFileSync(path.join(import.meta.dirname, "fixtures/guide.xml"), "utf8");
  for (const [k, v] of Object.entries(times)) guide = guide.replaceAll(`{{${k}}}`, xmltvTime(v));
  const requests: string[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    requests.push(url.pathname + (url.searchParams.get("action") ? `?action=${url.searchParams.get("action")}` : ""));
    const authed = url.searchParams.get("username") === MOCK_USER && url.searchParams.get("password") === MOCK_PASS;
    const json = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "text/html" }); // real panels often mislabel JSON
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/xmltv.php") {
      if (!authed) return void res.writeHead(401).end();
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return void res.end(zlib.gzipSync(guide));
    }
    if (url.pathname !== "/player_api.php") return void res.writeHead(404).end();
    if (!authed) return json({ user_info: { auth: 0 } });

    switch (url.searchParams.get("action")) {
      case null:
        return json({
          user_info: { auth: 1, status: "Active", exp_date: "1893456000", max_connections: "2", active_cons: "0" },
          server_info: { timezone: "Europe/Berlin" },
        });
      case "get_live_categories":
        return json([
          { category_id: "1", category_name: "UK | General" },
          { category_id: "2", category_name: "DE | General" },
        ]);
      case "get_live_streams":
        return json([
          { num: 1, name: "UK: BBC One FHD", stream_type: "live", stream_id: 101, epg_channel_id: "BBCOne.uk", stream_icon: "", category_id: "1" },
          { num: 2, name: "UK: BBC One HD", stream_type: "live", stream_id: 102, epg_channel_id: "bbcone.uk", stream_icon: "http://img/b.png", category_id: "1" },
          { num: 3, name: "DE: Das Erste HD", stream_type: "live", stream_id: 201, epg_channel_id: "", stream_icon: "", category_id: "2" },
          { num: 4, name: "DE: Mystery Channel", stream_type: "live", stream_id: 202, epg_channel_id: null, stream_icon: "", category_id: "2" },
          { num: 5, name: "DE: Silent Channel", stream_type: "live", stream_id: 203, epg_channel_id: null, stream_icon: "", category_id: "2" },
        ]);
      case "get_simple_data_table": {
        const id = url.searchParams.get("stream_id");
        if (id !== "202") return json({ epg_listings: [] });
        return json({
          epg_listings: [
            { title: b64("Mystery Hour"), description: b64("Who did it?"), start_timestamp: String(times.T0), stop_timestamp: String(times.T1) },
            { title: b64("Mystery Hour 2"), description: b64(""), start_timestamp: String(times.T1), stop_timestamp: String(times.T2) },
          ],
        });
      }
      case "get_short_epg":
        return json({ epg_listings: [] });
      default:
        return json([]);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    times,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
