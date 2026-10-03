import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const databaseUrl = process.env.API_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;
const origin = "http://monitor.test";

async function migrate(): Promise<void> {
  await execFile(
    process.execPath,
    ["node_modules/node-pg-migrate/bin/node-pg-migrate.js", "up", "--migrations-dir", "db/migrations", "--database-url-var", "MIGRATION_DATABASE_URL"],
    { env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl } },
  );
}

function mutation(url: string, method: "POST" | "DELETE", body?: unknown): Request {
  return new Request(url, {
    method,
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describeWithDatabase("service API with PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.APP_ORIGIN = origin;
    await migrate();
  });

  beforeEach(async () => {
    const { getPool } = await import("@/server/db");
    await getPool().query("TRUNCATE services CASCADE");
  });

  afterAll(async () => {
    const { closePool } = await import("@/server/db");
    await closePool();
  });

  it("creates, replays, lists, details, and permanently deletes a service", async () => {
    const { POST, GET: list } = await import("@/app/api/services/route");
    const detail = await import("@/app/api/services/[id]/route");
    const key = crypto.randomUUID();
    const request = () => new Request(`${origin}/api/services`, {
      method: "POST",
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ name: "Example", url: "https://example.com/health" }),
    });
    const created = await POST(request());
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toMatch(/^\/api\/services\//);
    expect(created.headers.get("cache-control")).toContain("no-store");
    const service = (await created.json()) as { id: string; status: string };
    expect(service.status).toBe("pending");

    const replay = await POST(request());
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { id: string }).id).toBe(service.id);

    const listed = await list();
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { counts: { pending: number } }).counts.pending).toBe(1);

    const context = { params: Promise.resolve({ id: service.id }) };
    expect((await detail.GET(new Request(`${origin}/api/services/${service.id}`), context)).status).toBe(200);
    expect((await detail.DELETE(mutation(`${origin}/api/services/${service.id}`, "DELETE"), context)).status).toBe(204);
    expect((await detail.DELETE(mutation(`${origin}/api/services/${service.id}`, "DELETE"), context)).status).toBe(204);
  });

  it("rejects malformed mutations and cross-origin writes with structured errors", async () => {
    const { POST } = await import("@/app/api/services/route");
    const crossOrigin = await POST(
      new Request(`${origin}/api/services`, {
        method: "POST",
        headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: "{}",
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(((await crossOrigin.json()) as { error: { code: string; requestId: string } }).error.code).toBe("ORIGIN_FORBIDDEN");

    const invalid = await POST(mutation(`${origin}/api/services`, "POST", { name: "", url: "not a URL" }));
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("reports liveness and migrated database readiness without caching", async () => {
    const live = await import("@/app/api/health/live/route");
    const ready = await import("@/app/api/health/ready/route");
    const liveResponse = live.GET();
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.headers.get("cache-control")).toContain("no-store");
    const readyResponse = await ready.GET();
    expect(readyResponse.status).toBe(200);
    expect((await readyResponse.json()) as { status: string }).toEqual({ status: "ok" });
  });

  it("uses an anchored keyset cursor for exact history", async () => {
    const { POST } = await import("@/app/api/services/route");
    const history = await import("@/app/api/services/[id]/history/route");
    const created = await POST(mutation(`${origin}/api/services`, "POST", { name: "History", url: "https://example.org/status" }));
    const service = (await created.json()) as { id: string };
    const { getPool } = await import("@/server/db");
    await getPool().query(
      `
        INSERT INTO health_checks (
          service_id, lease_token, scheduled_at, started_at, completed_at, outcome, http_status,
          response_time_ms, total_duration_ms, error_code, accepted_status_min, accepted_status_max
        ) VALUES
          ($1, gen_random_uuid(), now() - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes', 'up', 200, 10, 10, NULL, 200, 299),
          ($1, gen_random_uuid(), now() - interval '1 minute', now() - interval '1 minute', now() - interval '1 minute', 'up', 200, 11, 11, NULL, 200, 299)
      `,
      [service.id],
    );
    const context = { params: Promise.resolve({ id: service.id }) };
    const first = await history.GET(new Request(`${origin}/api/services/${service.id}/history?range=24h&limit=1`), context);
    const firstBody = (await first.json()) as { asOf: string; checks: Array<{ id: string }>; nextCursor: string | null };
    expect(firstBody.checks).toHaveLength(1);
    expect(firstBody.nextCursor).not.toBeNull();

    await getPool().query(
      `INSERT INTO health_checks (service_id, lease_token, scheduled_at, started_at, completed_at, outcome, http_status, response_time_ms, total_duration_ms, error_code, accepted_status_min, accepted_status_max)
       VALUES ($1, gen_random_uuid(), now() + interval '1 minute', now() + interval '1 minute', now() + interval '1 minute', 'up', 200, 12, 12, NULL, 200, 299)`,
      [service.id],
    );
    const second = await history.GET(new Request(`${origin}/api/services/${service.id}/history?range=24h&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`), context);
    const secondBody = (await second.json()) as { asOf: string; checks: Array<{ id: string }> };
    expect(secondBody.asOf).toBe(firstBody.asOf);
    expect(secondBody.checks).toHaveLength(1);
    expect(secondBody.checks[0]?.id).not.toBe(firstBody.checks[0]?.id);
  });
});
