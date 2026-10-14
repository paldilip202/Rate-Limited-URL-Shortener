import { pool } from "../infra/db.js";
import { encodeBase62 } from "./base62.js";
import { redis } from "../infra/redis.js";
import { randomUUID } from "node:crypto";

export async function createShortUrl(longUrl: string): Promise<string> {
  // 1. ask Postgres for the next unique ID
  const idResult = await pool.query(
    "SELECT nextval(pg_get_serial_sequence('urls', 'id')) AS id"
  );
  const id = BigInt(idResult.rows[0].id);

  // 2. turn the ID into a short code
  const code = encodeBase62(id);

  // 3. save it
  await pool.query(
    "INSERT INTO urls (id, code, long_url) VALUES ($1, $2, $3)",
    [id.toString(), code, longUrl]
  );

  return code;
}

export async function findByCode(code: string) {
  console.log("DB lookup for", code);
  const result = await pool.query(
    "SELECT long_url, expires_at FROM urls WHERE code = $1",
    [code]
  );
  return result.rows[0] ?? null;
}

const CACHE_TTL_SECONDS = 3600; // 1 hour
const NOT_FOUND_TTL_SECONDS = 60;

type Cached = { long_url: string; expires_at: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// release the lock only if it is still OURS (checked and deleted atomically)
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

// returns: undefined = cache miss, null = known "not found", object = cached row
async function readCache(key: string): Promise<Cached | null | undefined> {
  const cached = await redis.get(key);
  if (!cached) return undefined;
  if (cached === "NOT_FOUND") return null;
  return JSON.parse(cached) as Cached;
}

// ask Postgres, then try to save the answer in Redis
async function loadAndCache(key: string, code: string) {
  const row = await findByCode(code);
  try {
    if (!row) {
      await redis.set(key, "NOT_FOUND", "EX", NOT_FOUND_TTL_SECONDS);
    } else {
      const jitter = Math.floor(Math.random() * 360);
      await redis.set(key, JSON.stringify(row), "EX", CACHE_TTL_SECONDS + jitter);
    }
  } catch (err) {
    console.error("Redis write failed, continuing", err);
  }
  return row;
}

export async function resolveCode(code: string) {
  const key = `url:${code}`;
  const lockKey = `lock:${key}`;

  // 1. check the cache
  try {
    const hit = await readCache(key);
    if (hit !== undefined) return hit;
  } catch (err) {
    // Redis is down: skip all cache logic, go straight to Postgres
    console.error("Redis read failed, falling back to Postgres", err);
    return findByCode(code);
  }

  // 2. cache miss: try to become the one request that refills it
  const token = randomUUID();
  let gotLock = false;
  try {
    gotLock = (await redis.set(lockKey, token, "EX", 5, "NX")) === "OK";
  } catch {}

  if (gotLock) {
    try {
      return await loadAndCache(key, code);
    } finally {
      await redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => {});
    }
  }

  // 3. someone else is refilling: wait a little and check the cache again
  for (let i = 0; i < 10; i++) {
    await sleep(50);
    try {
      const hit = await readCache(key);
      if (hit !== undefined) return hit;
    } catch {
      break;
    }
  }

  // 4. still nothing after ~500 ms: stop waiting and ask Postgres ourselves
  return loadAndCache(key, code);
}

export async function getStats(code: string) {
  const result = await pool.query(
    "SELECT click_count, created_at FROM urls WHERE code = $1",
    [code]
  );
  const row = result.rows[0];
  if (!row) return null;

  // clicks still waiting in Redis to be flushed
  let pending = 0;
  try {
    pending = Number((await redis.get(`clicks:${code}`)) ?? 0);
  } catch {}

  return {
    code,
    clicks: Number(row.click_count) + pending,
    createdAt: row.created_at,
  };
}