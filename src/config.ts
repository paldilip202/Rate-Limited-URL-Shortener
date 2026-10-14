import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  BASE_URL: z.string().default("http://localhost:8080"),
  REDIRECT_CAPACITY: z.coerce.number().default(300),
  REDIRECT_REFILL: z.coerce.number().default(5),
});

export const config = schema.parse(process.env);