import { redis } from "../infra/redis.js";
import { pool } from "../infra/db.js";

let running = false;

export async function flushOnce() {
  if (running) return; // don't start a second flush while one is still going
  running = true;

  try {
    let cursor = "0";
    do {
      // SCAN walks through keys in small pages (safe, unlike KEYS)
      const [next, keys] = await redis.scan(cursor, "MATCH", "clicks:*", "COUNT", 100);
      cursor = next;

      for (const key of keys) {
        // atomic: read the value AND delete the key in one step
        const value = await redis.getdel(key);
        if (!value) continue;

        const count = Number(value);
        const code = key.slice("clicks:".length);

        try {
          await pool.query(
            "UPDATE urls SET click_count = click_count + $1 WHERE code = $2",
            [count, code]
          );
        } catch (err) {
          // Postgres failed: put the count back so it isn't lost
          await redis.incrby(key, count).catch(() => {});
          console.error("click flush failed for", code, err);
        }
      }
    } while (cursor !== "0");
  } catch (err) {
    console.error("click flusher error", err);
  } finally {
    running = false;
  }
}

export function startClickFlusher(intervalMs = 10_000) {
  const timer = setInterval(() => {
    flushOnce();
  }, intervalMs);
  return () => clearInterval(timer);
}