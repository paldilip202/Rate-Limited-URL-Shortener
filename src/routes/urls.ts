import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { tokenBucket } from "../middleware/tokenBucket.js";
import { redis } from "../infra/redis.js";
import { createShortUrl, resolveCode, getStats } from "../services/urlService.js";

const shortenBody = z.object({
  url: z
    .string()
    .max(2048)
    .url()
    .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
      message: "Only http and https URLs are allowed",
    }),
});

export async function urlRoutes(app: FastifyInstance) {
  app.post("/api/v1/shorten", { preHandler: tokenBucket("shorten", 10, 10 / 60) },
  async (req, reply) => {
    const parsed = shortenBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid URL" });
    }

    const code = await createShortUrl(parsed.data.url);
    return reply.code(201).send({
      code,
      shortUrl: `${config.BASE_URL}/${code}`,
    });
  });

    app.get<{ Params: { code: string } }>(
    "/api/v1/urls/:code/stats",
    async (req, reply) => {
      const stats = await getStats(req.params.code);
      if (!stats) return reply.code(404).send({ error: "Not found" });
      return stats;
    }
  );

  app.get<{ Params: { code: string } }>("/:code", { preHandler: tokenBucket("redirect", config.REDIRECT_CAPACITY, config.REDIRECT_REFILL) },
   async (req, reply) => {
    const row = await resolveCode(req.params.code);

    if (!row) {
      return reply.code(404).send({ error: "Not found" });
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return reply.code(410).send({ error: "Link expired" });
    }

    // count the click without making the user wait
    redis.incr(`clicks:${req.params.code}`).catch(() => {});

    return reply.redirect(row.long_url, 302);
  });
}