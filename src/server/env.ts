import "server-only";

import { z } from "zod";

const httpOrigin = z
  .string()
  .url("APP_ORIGIN must be an absolute HTTP(S) URL.")
  .transform((value, context) => {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "APP_ORIGIN must use HTTP or HTTPS." });
    }
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      context.addIssue({ code: "custom", message: "APP_ORIGIN must not include a path, query, or fragment." });
    }
    return parsed.origin;
  });

const positiveInteger = (defaultValue: number, maximum: number) =>
  z.coerce.number().int().min(1).max(maximum).default(defaultValue);

export const ServerEnvSchema = z.object({
  APP_ORIGIN: httpOrigin,
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required.").url("DATABASE_URL must be a URL."),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_POOL_MAX: positiveInteger(10, 50),
  DATABASE_CONNECTION_TIMEOUT_MS: positiveInteger(5_000, 60_000),
  DATABASE_STATEMENT_TIMEOUT_MS: positiveInteger(10_000, 120_000),
  WORKER_CONCURRENCY: positiveInteger(5, 25),
  MAX_SERVICES: positiveInteger(100, 10_000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ServerEnv = z.output<typeof ServerEnvSchema>;

export function parseServerEnv(
  input: Record<string, string | undefined> = process.env,
): ServerEnv {
  return ServerEnvSchema.parse(input);
}
