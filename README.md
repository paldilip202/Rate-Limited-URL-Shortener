# Rate-Limited URL Shortener

A read-heavy URL shortening service built with **Node.js, TypeScript, Fastify, PostgreSQL and Redis**. It runs as three stateless API instances behind an nginx load balancer, using Docker Compose.

Built to practice backend system design: caching, rate limiting, atomic operations, graceful degradation, and measuring results with load tests.

## Features

- Create short links (`POST /api/v1/shorten`) and redirect (`GET /:code`)
- Redis cache-aside with TTL jitter, negative caching, and a stampede lock
- Distributed token-bucket rate limiter (Redis Lua script)
- Click counting in Redis, flushed to PostgreSQL in batches
- Graceful degradation when Redis is down
- Health endpoints (`/healthz`, `/readyz`) and graceful shutdown on `SIGTERM`

## Architecture

```
Client
  │
  ▼
nginx (load balancer)
  │
  ▼
Fastify API x3 (stateless)
  │               │
  ▼               ▼
Redis           PostgreSQL
- URL cache     - Source of truth
- Rate limits   - urls table
- Click counters
  ▲
  │ every 10s (GETDEL, batched UPDATE)
Click flusher (runs inside each API instance)
```

API instances keep no state in memory. Anything shared (cache, rate limits, counters) lives in Redis or PostgreSQL, so instances can be added or removed freely.

## Tech stack

| Area | Tools |
|---|---|
| Runtime / language | Node.js 22, TypeScript |
| Web framework | Fastify |
| Validation / config | Zod |
| Database | PostgreSQL 16 (`pg`) |
| Cache / limits / counters | Redis 7 (`ioredis`) |
| Load balancer | nginx |
| Containers | Docker, Docker Compose |
| Load testing | autocannon |

## Run it

Requirements: Docker Desktop.

```bash
docker compose up --build --scale api=3
```

The service is available at `http://localhost:8080`.

```bash
# create a short link
curl -X POST localhost:8080/api/v1/shorten \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.wikipedia.org"}'

# open it (302 redirect)
curl -i localhost:8080/1

# stats
curl localhost:8080/api/v1/urls/1/stats

# health
curl localhost:8080/healthz
curl localhost:8080/readyz
```

On Windows PowerShell use `curl.exe` instead of `curl`.

## API

| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/shorten` | Body `{ "url": "https://..." }`. Returns `201 { code, shortUrl }`. `400` for invalid URLs. |
| GET | `/:code` | `302` redirect. `404` if unknown, `410` if expired. |
| GET | `/api/v1/urls/:code/stats` | Click count (including clicks not yet flushed) and creation date. |
| GET | `/healthz` | Liveness: is the process up? |
| GET | `/readyz` | Readiness: can it reach Postgres and Redis? |

Rate-limited responses return `429` with `Retry-After`, `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | API port inside the container |
| `DATABASE_URL` | required | Postgres connection string |
| `REDIS_URL` | required | Redis connection string |
| `BASE_URL` | `http://localhost:8080` | Used to build short URLs |
| `REDIRECT_CAPACITY` | `300` | Redirect bucket size per IP |
| `REDIRECT_REFILL` | `5` | Redirect tokens refilled per second per IP |

## Design decisions

1. **302, not 301.** A 301 is cached by browsers, so repeat visits would never reach the server and clicks could not be counted. Tradeoff: more server load.
2. **Short codes = base62 of a Postgres sequence value.** Postgres never issues the same ID twice, even across instances, so there are no collisions and no coordination. Tradeoff: codes are sequential and guessable.
3. **Cache-aside with three protections.**
   - *TTL jitter:* random extra seconds so keys do not all expire together.
   - *Negative caching:* unknown codes are remembered for 60 seconds so random codes cannot hammer the database.
   - *Stampede lock:* `SET NX` with a 5 second expiry lets one request refill an expired hot key while others wait and re-check the cache. The lock holds a random token and is released by a Lua script ("delete only if still mine").
4. **Token bucket rate limiter in a Lua script.** A fixed window allows a 2x burst at window boundaries. A token bucket refills steadily. The read-calculate-write runs as one atomic Redis operation, so two instances cannot both spend the last token. Redis time is used so all instances agree on the clock.
5. **Async click counting.** Each redirect does `INCR clicks:<code>`. Every 10 seconds the flusher takes each counter with atomic `GETDEL` and applies one `UPDATE` per link. If the Postgres update fails, the count is put back. Tradeoff: up to ~10 seconds of counts can be lost if Redis crashes. Acceptable for analytics, not for billing.
6. **Stateless API.** No per-user state in process memory, so the rate limit stays correct at any number of instances.
7. **Atomicity everywhere it matters.**

   | Problem | Broken approach | Used instead |
   |---|---|---|
   | Click counter reset | `GET` then `SET 0` | `GETDEL` |
   | Rate limiting | read, compute, write in Node | Lua script |
   | Lock release | `DEL` | token-checked Lua release |
   | Unique alias | check then insert | insert and catch unique violation |

## Failure behavior

| Failure | Behavior |
|---|---|
| Redis down | Redirects fall back to Postgres (slower, still working). Rate limiter fails open. Clicks during the outage are not counted. |
| Postgres down | Cached redirects keep working. Creating links fails. |
| One API instance down | nginx routes to the others. |
| Hot key expires | Stampede lock keeps database load to about one lookup. |
| API receives `SIGTERM` | Stops accepting requests, finishes in-flight ones, flushes pending click counts, closes connections. |

Redis is configured with `enableOfflineQueue: false` and `maxRetriesPerRequest: 1` so commands fail fast instead of hanging.

## Results

Environment: local Docker on one Windows laptop, 3 API instances, autocannon with 50 connections for 10 seconds unless noted.

| Test | Result |
|---|---|
| Redirect, cache off vs on | 842 to 1,880 req/s (about 2.2x) |
| Redirect p50 latency | 49 ms to 23 ms |
| Redirect p99 latency | 203 ms to 75 ms |
| Stampede: 50 concurrent requests, cold key, 3 instances | 1 Postgres lookup (instead of about 50) |
| Final load, 50 connections (with limiter and click counting) | _TODO: req/s, p99_ |
| Final load, 10 connections | _TODO: req/s, p97.5_ |
| 1M-row lookup by `code`, seq scan vs unique index | _TODO: ms to ms (`EXPLAIN ANALYZE`)_ |
| Rate limiter, 310 requests with real limits | _TODO: expected ~300 allowed, ~10 `429`_ |
| Click batching, N redirects to M `UPDATE`s | _TODO_ |

Autocannon reports `0 2xx responses` because redirects are `302`, not `200`. That is expected.

## Limitations

- The load generator, nginx, API, Postgres and Redis all share one machine, so absolute numbers are lower than a real deployment. The relative comparisons are what matter.
- The cache-off run also logs an error per request, which slightly exaggerates the gap.
- No authentication or user accounts.
- Up to ~10 seconds of click counts can be lost if Redis crashes.
- `/readyz` fails when Redis is down, which may be stricter than needed.
- Single Postgres and single Redis instance (single points of failure).
- Custom aliases and expiry are in the schema but not exposed in the create endpoint yet.

## Scaling path (designed, not built)

1. More stateless API instances.
2. Postgres read replicas for cache misses (watch replication lag on fresh links).
3. Redis replication or Cluster.
4. CDN or edge cache for very hot links.
5. Shard Postgres only if write volume demands it. At about 4 writes/sec it does not.

## Project structure

```
url-shortener/
├── docker-compose.yml
├── Dockerfile
├── nginx/nginx.conf
├── db/init.sql
└── src/
    ├── server.ts            # entry point, graceful shutdown
    ├── app.ts               # Fastify setup
    ├── config.ts            # env vars validated with Zod
    ├── infra/               # Postgres pool, Redis client
    ├── routes/              # health, urls
    ├── services/            # base62, cache-aside, lock, stats
    ├── middleware/          # token bucket (and fixed window) limiter
    └── workers/             # click flusher
```

## What I learned

- Whenever a decision depends on a value just read, the read and write must be one atomic step.
- A cache is a helper, not a requirement: the system must still work without it.
- Measure before claiming improvements, and state the limits of the test.
