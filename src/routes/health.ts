import type { FastifyInstance } from "fastify";
import { pool } from "../infra/db.js";
import { redis } from "../infra/redis.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      await redis.ping();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not ready" });
    }
  });
}