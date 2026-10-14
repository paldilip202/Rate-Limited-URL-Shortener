import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { urlRoutes } from "./routes/urls.js";

export function buildApp() {
  const app = Fastify({ logger: true, trustProxy: true });
  app.register(healthRoutes);
  app.register(urlRoutes);
  return app;
}