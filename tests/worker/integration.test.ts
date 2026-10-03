import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { claimDueServices, persistCompletedProbe } from "@/worker/repository";

const execFile = promisify(execFileCallback);
const databaseUrl = process.env.WORKER_TEST_DATABASE_URL ?? process.env.API_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;
let pool: Pool;

async function migrate(): Promise<void> {
  await execFile(
    process.execPath,
    ["node_modules/node-pg-migrate/bin/node-pg-migrate.js", "up", "--migrations-dir", "db/migrations", "--database-url-var", "MIGRATION_DATABASE_URL"],
    { env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl } },
  );
}

describeWithDatabase("worker PostgreSQL coordination", () => {
  beforeAll(async () => {
    await migrate();
    pool = new Pool({ connectionString: databaseUrl });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE services CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("claims separate due rows concurrently and persists one fenced result atomically", async () => {
    await pool.query(
      `INSERT INTO services (name, normalized_url, interval_seconds, next_check_at)
       VALUES ('One', 'https://one.example.test/health', 60, now() - interval '1 minute'),
              ('Two', 'https://two.example.test/health', 60, now() - interval '1 minute')`,
    );
    const ownerOne = "00000000-0000-4000-8000-000000000010";
    const ownerTwo = "00000000-0000-4000-8000-000000000011";
    const [first, second] = await Promise.all([
      claimDueServices(pool, ownerOne, 1, 45),
      claimDueServices(pool, ownerTwo, 1, 45),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.id).not.toBe(second[0]?.id);

    const claim = first[0]!;
    const status = await persistCompletedProbe(pool, claim, {
      completedAt: new Date(),
      outcome: "up",
      httpStatus: 204,
      responseTimeMs: 12,
      totalDurationMs: 15,
      errorCode: null,
    });
    expect(status).toBe("persisted");

    const stored = await pool.query<{ check_count: string; bucket_count: string; lease_token: string | null }>(
      `SELECT
         (SELECT count(*) FROM health_checks WHERE service_id = $1) AS check_count,
         (SELECT count(*) FROM health_check_hourly WHERE service_id = $1) AS bucket_count,
         (SELECT lease_token FROM services WHERE id = $1) AS lease_token`,
      [claim.id],
    );
    expect(stored.rows[0]).toEqual({ check_count: "1", bucket_count: "1", lease_token: null });

    expect(await persistCompletedProbe(pool, claim, {
      completedAt: new Date(),
      outcome: "up",
      httpStatus: 204,
      responseTimeMs: 12,
      totalDurationMs: 15,
      errorCode: null,
    })).toBe("fenced");
  });
});
