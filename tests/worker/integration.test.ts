import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimDueServices, persistCompletedProbe } from "@/worker/repository";

const execFile = promisify(execFileCallback);
const databaseUrl = process.env.WORKER_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;
let pool: Pool | undefined;
const runId = crypto.randomUUID();
const fixtureServiceIds = new Set<string>();

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

  afterAll(async () => {
    if (pool === undefined) return;
    if (fixtureServiceIds.size > 0) {
      await pool.query("DELETE FROM services WHERE id = ANY($1::uuid[])", [[...fixtureServiceIds]]);
    }
    await pool.end();
  });

  it("claims separate due rows concurrently and persists one fenced result atomically", async () => {
    const testPool = pool;
    if (testPool === undefined) throw new Error("Test database pool was not initialized.");
    const inserted = await testPool.query<{ id: string }>(
      `INSERT INTO services (name, normalized_url, interval_seconds, next_check_at)
       VALUES ($1, $2, 60, now() - interval '1 minute'),
              ($3, $4, 60, now() - interval '1 minute')
       RETURNING id`,
      [`One ${runId}`, `https://one-${runId}.example.test/health`, `Two ${runId}`, `https://two-${runId}.example.test/health`],
    );
    for (const row of inserted.rows) fixtureServiceIds.add(row.id);
    const ownerOne = "00000000-0000-4000-8000-000000000010";
    const ownerTwo = "00000000-0000-4000-8000-000000000011";
    const [first, second] = await Promise.all([
      claimDueServices(testPool, ownerOne, 1, 45),
      claimDueServices(testPool, ownerTwo, 1, 45),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.id).not.toBe(second[0]?.id);

    const claim = first[0]!;
    const persisted = await persistCompletedProbe(testPool, claim, {
      outcome: "up",
      httpStatus: 204,
      responseTimeMs: 12,
      totalDurationMs: 15,
      errorCode: null,
    });
    expect(persisted.status).toBe("persisted");

    const stored = await testPool.query<{ check_count: string; bucket_count: string; lease_token: string | null }>(
      `SELECT
         (SELECT count(*) FROM health_checks WHERE service_id = $1) AS check_count,
         (SELECT count(*) FROM health_check_hourly WHERE service_id = $1) AS bucket_count,
         (SELECT lease_token FROM services WHERE id = $1) AS lease_token`,
      [claim.id],
    );
    expect(stored.rows[0]).toEqual({ check_count: "1", bucket_count: "1", lease_token: null });

    expect((await persistCompletedProbe(testPool, claim, {
      outcome: "up",
      httpStatus: 204,
      responseTimeMs: 12,
      totalDurationMs: 15,
      errorCode: null,
    })).status).toBe("fenced");
  });
});
