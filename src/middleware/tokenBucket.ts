import type { FastifyRequest, FastifyReply } from "fastify";
import { redis } from "../infra/redis.js";

const SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])

-- use Redis's own clock so all API copies agree on the time
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

-- first time we see this user: start with a full bucket
if tokens == nil then
  tokens = capacity
  ts = now
end

-- add tokens for the time that passed, but never above capacity
local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill_per_sec)

local allowed = 0
local retry_after = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after = math.ceil((1 - tokens) / refill_per_sec)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- delete the key when the bucket would be full again anyway
redis.call('EXPIRE', key, math.ceil(capacity / refill_per_sec) + 1)

return { allowed, math.floor(tokens), retry_after }
`;

export function tokenBucket(
  name: string,
  capacity: number,
  refillPerSec: number
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = `tb:${name}:${req.ip}`;

    try {
      const [allowed, remaining, retryAfter] = (await redis.eval(
        SCRIPT,
        1,
        key,
        capacity,
        refillPerSec
      )) as [number, number, number];

      reply.header("X-RateLimit-Limit", capacity);
      reply.header("X-RateLimit-Remaining", remaining);

      if (allowed === 0) {
        reply.header("Retry-After", retryAfter);
        return reply.code(429).send({ error: "Too many requests" });
      }
    } catch (err) {
      // Redis is down: fail open
      req.log.error({ err }, "rate limiter failed, allowing request");
    }
  };
}