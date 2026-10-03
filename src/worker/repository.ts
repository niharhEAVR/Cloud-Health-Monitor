import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";

import { advanceSchedule } from "./schedule.js";

export interface ClaimedService {
  id: string;
  normalizedUrl: string;
  intervalSeconds: number;
  acceptedStatusMin: number;
  acceptedStatusMax: number;
  scheduledAt: Date;
  leaseToken: string;
}

export interface CompletedProbe {
  outcome: "up" | "down";
  httpStatus: number | null;
  responseTimeMs: number | null;
  totalDurationMs: number;
  errorCode: "HTTP_STATUS" | "TIMEOUT" | "DNS_ERROR" | "TLS_ERROR" | "CONNECTION_ERROR" | "TARGET_BLOCKED" | "PROTOCOL_ERROR" | null;
}

interface ClaimedServiceRow {
  id: string;
  normalized_url: string;
  interval_seconds: number;
  accepted_status_min: number;
  accepted_status_max: number;
  next_check_at: Date;
  lease_token: string;
}

export async function claimDueServices(
  pool: Pool,
  owner: string,
  limit: number,
  leaseSeconds: number,
): Promise<ClaimedService[]> {
  if (limit <= 0) {
    return [];
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ClaimedServiceRow>(
      `WITH due AS (
         SELECT id
         FROM services
         WHERE next_check_at <= now()
           AND (lease_token IS NULL OR lease_expires_at <= now())
         ORDER BY next_check_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE services AS service
       SET lease_token = gen_random_uuid(),
           lease_owner = $2,
           lease_expires_at = now() + ($3 * interval '1 second')
       FROM due
       WHERE service.id = due.id
       RETURNING service.id, service.normalized_url, service.interval_seconds,
                 service.accepted_status_min, service.accepted_status_max,
                 service.next_check_at, service.lease_token`,
      [limit, owner, leaseSeconds],
    );
    await client.query("COMMIT");
    return result.rows.map((row) => ({
      id: row.id,
      normalizedUrl: row.normalized_url,
      intervalSeconds: row.interval_seconds,
      acceptedStatusMin: row.accepted_status_min,
      acceptedStatusMax: row.accepted_status_max,
      scheduledAt: row.next_check_at,
      leaseToken: row.lease_token,
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function persistCompletedProbe(
  pool: Pool,
  claim: ClaimedService,
  result: CompletedProbe,
): Promise<"persisted" | "fenced" | "duplicate"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lease = await client.query<{ id: string }>(
      `SELECT id
       FROM services
       WHERE id = $1 AND lease_token = $2 AND lease_expires_at > now()
       FOR UPDATE`,
      [claim.id, claim.leaseToken],
    );
    if (lease.rowCount !== 1) {
      await client.query("ROLLBACK");
      return "fenced";
    }

    // Use one database clock for completed_at, the hourly bucket, and schedule
    // advancement. A worker host clock must not move an observation across a
    // UTC bucket or cadence slot.
    const clock = await client.query<{ completed_at: Date }>("SELECT clock_timestamp() AS completed_at");
    const completedAt = clock.rows[0]!.completed_at;
    const inserted = await client.query(
      `INSERT INTO health_checks (
         service_id, lease_token, scheduled_at, started_at, completed_at,
         outcome, http_status, response_time_ms, total_duration_ms, error_code,
         accepted_status_min, accepted_status_max
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (lease_token) DO NOTHING`,
      [
        claim.id,
        claim.leaseToken,
        claim.scheduledAt,
        new Date(completedAt.getTime() - result.totalDurationMs),
        completedAt,
        result.outcome,
        result.httpStatus,
        result.responseTimeMs,
        result.totalDurationMs,
        result.errorCode,
        claim.acceptedStatusMin,
        claim.acceptedStatusMax,
      ],
    );
    if (inserted.rowCount !== 1) {
      await client.query("ROLLBACK");
      return "duplicate";
    }

    await updateHourlyAggregate(client, claim.id, result, completedAt);
    const nextCheckAt = advanceSchedule(claim.scheduledAt, claim.intervalSeconds, completedAt);
    await client.query(
      `UPDATE services
       SET latest_scheduled_at = $3,
           latest_completed_at = $4,
           latest_outcome = $5,
           latest_http_status = $6,
           latest_response_time_ms = $7,
           latest_duration_ms = $8,
           latest_error_code = $9,
           next_check_at = $10,
           lease_token = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2`,
      [
        claim.id,
        claim.leaseToken,
        claim.scheduledAt,
        completedAt,
        result.outcome,
        result.httpStatus,
        result.responseTimeMs,
        result.totalDurationMs,
        result.errorCode,
        nextCheckAt,
      ],
    );
    await client.query("COMMIT");
    return "persisted";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function updateHourlyAggregate(
  client: PoolClient,
  serviceId: string,
  result: CompletedProbe,
  completedAt: Date,
): Promise<void> {
  const accepted = result.outcome === "up" ? 1 : 0;
  const hasResponseTime = result.responseTimeMs === null ? 0 : 1;
  await client.query(
    `INSERT INTO health_check_hourly (
       service_id, hour_start, completed_checks, accepted_checks, response_time_count,
       response_time_sum_ms, response_time_min_ms, response_time_max_ms
     ) VALUES (
       $1, date_trunc('hour', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
       1, $3, $4, $5, $6, $6
     )
     ON CONFLICT (service_id, hour_start) DO UPDATE
     SET completed_checks = health_check_hourly.completed_checks + 1,
         accepted_checks = health_check_hourly.accepted_checks + EXCLUDED.accepted_checks,
         response_time_count = health_check_hourly.response_time_count + EXCLUDED.response_time_count,
         response_time_sum_ms = health_check_hourly.response_time_sum_ms + EXCLUDED.response_time_sum_ms,
         response_time_min_ms = CASE
           WHEN EXCLUDED.response_time_count = 0 THEN health_check_hourly.response_time_min_ms
           WHEN health_check_hourly.response_time_min_ms IS NULL THEN EXCLUDED.response_time_min_ms
           ELSE LEAST(health_check_hourly.response_time_min_ms, EXCLUDED.response_time_min_ms)
         END,
         response_time_max_ms = CASE
           WHEN EXCLUDED.response_time_count = 0 THEN health_check_hourly.response_time_max_ms
           WHEN health_check_hourly.response_time_max_ms IS NULL THEN EXCLUDED.response_time_max_ms
           ELSE GREATEST(health_check_hourly.response_time_max_ms, EXCLUDED.response_time_max_ms)
         END`,
    [
      serviceId,
      completedAt,
      accepted,
      hasResponseTime,
      result.responseTimeMs ?? 0,
      result.responseTimeMs,
    ],
  );
}

export async function writeHeartbeat(pool: Pool, workerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeats (worker_id, last_seen_at, scheduler_ran_at)
     VALUES ($1, now(), now())
     ON CONFLICT (worker_id) DO UPDATE
     SET last_seen_at = now()`,
    [workerId],
  );
}

export async function writeSchedulerPass(pool: Pool, workerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeats (worker_id, last_seen_at, scheduler_ran_at)
     VALUES ($1, now(), now())
     ON CONFLICT (worker_id) DO UPDATE
     SET last_seen_at = now(), scheduler_ran_at = now()`,
    [workerId],
  );
}

export interface CleanupCounts {
  checks: number;
  hourly: number;
  heartbeats: number;
}

export async function runRetentionCleanup(pool: Pool, timeBudgetMs = 5_000, batchSize = 1_000): Promise<CleanupCounts | null> {
  const client = await pool.connect();
  let releaseAsBroken = false;
  let unlockError: unknown;
  let cleanupError: unknown;
  let cleanupCounts: CleanupCounts | null = null;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(735241901) AS acquired",
    );
    if (lock.rows[0]?.acquired) {
      try {
      let checks = 0;
      const cleanupDeadline = performance.now() + timeBudgetMs;
      for (;;) {
        const deleted = await client.query(
          `WITH expired AS (
             SELECT ctid FROM health_checks
             WHERE completed_at < now() - interval '90 days'
             ORDER BY completed_at ASC
             LIMIT $1
           )
           DELETE FROM health_checks WHERE ctid IN (SELECT ctid FROM expired)`,
          [batchSize],
        );
        checks += deleted.rowCount ?? 0;
        if ((deleted.rowCount ?? 0) < batchSize) {
          break;
        }
        if (performance.now() >= cleanupDeadline) {
          break;
        }
      }
      let hourly = 0;
      while (performance.now() < cleanupDeadline) {
        const deleted = await client.query(
          `WITH expired AS (
             SELECT ctid FROM health_check_hourly
             WHERE hour_start + interval '1 hour' <= now() - interval '90 days'
             ORDER BY hour_start ASC
             LIMIT $1
           )
           DELETE FROM health_check_hourly WHERE ctid IN (SELECT ctid FROM expired)`,
          [batchSize],
        );
        hourly += deleted.rowCount ?? 0;
        if ((deleted.rowCount ?? 0) < batchSize) {
          break;
        }
      }
      const heartbeats = await client.query(
        `DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '1 day'`,
      );
      cleanupCounts = { checks, hourly, heartbeats: heartbeats.rowCount ?? 0 };
      } catch (error) {
        cleanupError = error;
      }
      try {
        const unlocked = await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock(735241901) AS unlocked");
        if (!unlocked.rows[0]?.unlocked) {
          throw new Error("Worker retention advisory lock was not held.");
        }
      } catch (error) {
        releaseAsBroken = true;
        unlockError = error;
      }
    }
  } finally {
    client.release(releaseAsBroken ? new Error("Discarding client after advisory lock release failure.") : undefined);
  }
  if (unlockError) {
    throw unlockError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  return cleanupCounts;
}

export async function releaseWorkerLeases(pool: Pool, owner: string): Promise<number> {
  const result = await pool.query(
    `UPDATE services
     SET lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
     WHERE lease_owner = $1`,
    [owner],
  );
  return result.rowCount ?? 0;
}
