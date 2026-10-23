import { buildApp } from "./app.js";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { startScheduler } from "./lib/scheduler.js";
import { getOutputToken } from "./settings.js";
import { ensureXtreamEpgSource } from "./xtream/source.js";

const db = openDb(config.dataDir);
ensureXtreamEpgSource(db);
getOutputToken(db);

const app = buildApp(db, { logger: true });
const timer = startScheduler(db);

await app.listen({ port: config.port, host: config.host });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(timer);
    await app.close();
    db.close();
    process.exit(0);
  });
}
