import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./infra/db.js";
import { redis } from "./infra/redis.js";
import { startClickFlusher, flushOnce } from "./workers/clickFlusher.js";

const app = buildApp();

async function shutdown(signal: string) {
  app.log.info(`${signal} received, shutting down`);
  stopFlusher();
  await app.close();
  await flushOnce();   // save pending counts before we go away
  await pool.end();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const stopFlusher = startClickFlusher();

app.listen({ port: config.PORT, host: "0.0.0.0" });