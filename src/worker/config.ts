import { z } from "zod";

export const PROBE_DEADLINE_MS = 10_000;
const minimumLeaseSeconds = 30;

const positiveInteger = (defaultValue: number, maximum: number) =>
  z.coerce.number().int().min(1).max(maximum).default(defaultValue);

export const WorkerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required.").url("DATABASE_URL must be a URL."),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_POOL_MAX: positiveInteger(5, 25),
  DATABASE_CONNECTION_TIMEOUT_MS: positiveInteger(5_000, 60_000),
  DATABASE_STATEMENT_TIMEOUT_MS: positiveInteger(10_000, 120_000),
  WORKER_CONCURRENCY: positiveInteger(5, 25),
  // Leave room for result persistence after the 10-second probe deadline.
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(minimumLeaseSeconds).max(300).default(45),
  WORKER_POLL_INTERVAL_MS: positiveInteger(1_000, 60_000),
  WORKER_SHUTDOWN_GRACE_MS: positiveInteger(25_000, 120_000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type WorkerEnv = z.output<typeof WorkerEnvSchema>;

export function parseWorkerEnv(
  input: Record<string, string | undefined> = process.env,
): WorkerEnv {
  return WorkerEnvSchema.parse(input);
}
