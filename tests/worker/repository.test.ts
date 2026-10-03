import { describe, expect, it, vi } from "vitest";

import { claimDueServices, persistCompletedProbe } from "@/worker/repository";

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
        completedAt: new Date("2026-01-01T00:00:01.000Z"),
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
});
