import type { FastifyRequest, FastifyReply } from "fastify";
import { redis } from "../infra/redis.js";

export function rateLimit(name: string, limit: number, windowSeconds: number) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = `rl:${name}:${req.ip}`;

    try {
      // run 3 commands together: add 1, set timer only if none exists, read timer
      const results = await redis
        .multi()
        .incr(key)
        .expire(key, windowSeconds, "NX")
        .ttl(key)
        .exec();

      const count = Number(results![0][1]);
      const secondsLeft = Number(results![2][1]);

      reply.header("X-RateLimit-Limit", limit);
      reply.header("X-RateLimit-Remaining", Math.max(0, limit - count));

      if (count > limit) {
        reply.header("Retry-After", secondsLeft);
        return reply.code(429).send({ error: "Too many requests" });
      }
    } catch (err) {
      // Redis is down: fail open (allow the request)
      req.log.error({ err }, "rate limiter failed, allowing request");
    }
  };
}