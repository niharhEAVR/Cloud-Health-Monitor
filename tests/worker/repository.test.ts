import { describe, expect, it, vi } from "vitest";

import { claimDueServices, persistCompletedProbe, runRetentionCleanup, writeHeartbeat, writeSchedulerPass } from "@/worker/repository";

function poolWithClient(results: Array<{ rows?: unknown[]; rowCount?: number | null }>) {
  const query = vi.fn(async () => results.shift() ?? { rows: [], rowCount: 0 });
  const client = { query, release: vi.fn() };
  return { connect: vi.fn(async () => client), query, client };
}

describe("worker repository coordination", () => {
  it("uses SKIP LOCKED claims and commits a lease before probes run", async () => {
    const pool = poolWithClient([
      { rows: [] },
      {
        rows: [{
          id: "00000000-0000-4000-8000-000000000001",
          normalized_url: "https://example.test/health",
          interval_seconds: 60,
          accepted_status_min: 200,
          accepted_status_max: 299,
          next_check_at: new Date("2026-01-01T00:00:00.000Z"),
          lease_token: "00000000-0000-4000-8000-000000000002",
        }],
        rowCount: 1,
      },
      { rows: [] },
    ]);

    const claims = await claimDueServices(pool as never, "00000000-0000-4000-8000-000000000003", 2, 45);

    const calls = pool.client.query.mock.calls as unknown as Array<[string]>;
    expect(claims).toHaveLength(1);
    expect(String(calls[1]?.[0])).toContain("FOR UPDATE SKIP LOCKED");
    expect(String(calls[1]?.[0])).toContain("lease_expires_at");
    expect(calls.map((call) => call[0])).toContain("COMMIT");
  });

  it("fences a late result before inserting history or updating aggregates", async () => {
    const pool = poolWithClient([
      { rows: [] },
      { rows: [], rowCount: 0 },
      { rows: [] },
    ]);
    const status = await persistCompletedProbe(
      pool as never,
      {
        id: "00000000-0000-4000-8000-000000000001",
        normalizedUrl: "https://example.test/health",
        intervalSeconds: 60,
        acceptedStatusMin: 200,
        acceptedStatusMax: 299,
        scheduledAt: new Date("2026-01-01T00:00:00.000Z"),
        leaseToken: "00000000-0000-4000-8000-000000000002",
      },
      {
        outcome: "up",
        httpStatus: 204,
        responseTimeMs: 10,
        totalDurationMs: 10,
        errorCode: null,
      },
    );

    const calls = pool.client.query.mock.calls as unknown as Array<[string]>;
    expect(status).toBe("fenced");
    expect(calls).toHaveLength(3);
    expect(String(calls[2]?.[0])).toBe("ROLLBACK");
  });

  it("uses database time for a completed check and its next cadence slot", async () => {
    const databaseTime = new Date("2026-01-01T00:02:00.000Z");
    const pool = poolWithClient([
      { rows: [] },
      { rows: [{ id: "00000000-0000-4000-8000-000000000001" }], rowCount: 1 },
      { rows: [{ completed_at: databaseTime }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [] },
    ]);
    const claim = {
      id: "00000000-0000-4000-8000-000000000001",
      normalizedUrl: "https://example.test/health",
      intervalSeconds: 60,
      acceptedStatusMin: 200,
      acceptedStatusMax: 299,
      scheduledAt: new Date("2026-01-01T00:00:00.000Z"),
      leaseToken: "00000000-0000-4000-8000-000000000002",
    };
    await expect(persistCompletedProbe(pool as never, claim, {
      outcome: "up", httpStatus: 204, responseTimeMs: 10, totalDurationMs: 10, errorCode: null,
    })).resolves.toBe("persisted");

    const calls = pool.client.query.mock.calls as unknown as Array<[string, unknown[]?]>;
    expect(calls[2]?.[0]).toContain("clock_timestamp");
    expect(calls[3]?.[1]?.[4]).toEqual(databaseTime);
    expect(calls[5]?.[1]?.[3]).toEqual(databaseTime);
    expect(calls[5]?.[1]?.[9]).toEqual(new Date("2026-01-01T00:03:00.000Z"));
  });

  it("continues committed retention batches until it catches up", async () => {
    const pool = poolWithClient([
      { rows: [{ acquired: true }] },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 2 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 3 },
      { rows: [{ unlocked: true }] },
    ]);
    await expect(runRetentionCleanup(pool as never, 1_000, 1)).resolves.toEqual({ checks: 1, hourly: 2, heartbeats: 3 });
    expect(pool.client.release).toHaveBeenCalledWith(undefined);
  });

  it("discards an advisory-lock client when unlock fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
      if (sql.includes("pg_advisory_unlock")) throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };

    await expect(runRetentionCleanup(pool as never, 1_000, 1)).rejects.toThrow("connection lost");
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("keeps liveness heartbeats distinct from successful scheduler passes", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const pool = { query };
    await writeHeartbeat(pool as never, "00000000-0000-4000-8000-000000000010");
    await writeSchedulerPass(pool as never, "00000000-0000-4000-8000-000000000010");

    const calls = query.mock.calls as unknown as Array<[string]>;
    expect(calls[0]?.[0]).toContain("SET last_seen_at = now()");
    expect(calls[0]?.[0]).not.toContain("scheduler_ran_at = now()");
    expect(calls[1]?.[0]).toContain("scheduler_ran_at = now()");
  });
});
