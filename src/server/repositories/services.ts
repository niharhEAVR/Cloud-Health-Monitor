import "server-only";

import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import type { CheckOutcome } from "@/shared/contracts";
import { canonicalCreateRequest } from "@/shared/serialization";
import { queryOne } from "@/server/db";

export interface ServiceRecord {
  id: string;
  name: string;
  normalizedUrl: string;
  intervalSeconds: number;
  acceptedStatusMin: number;
  acceptedStatusMax: number;
  createdAt: Date;
  updatedAt: Date;
  nextCheckAt: Date;
  latestScheduledAt: Date | null;
  latestCompletedAt: Date | null;
  latestOutcome: CheckOutcome | null;
  latestHttpStatus: number | null;
  latestResponseTimeMs: number | null;
  latestDurationMs: number | null;
  latestErrorCode: string | null;
}

interface ServiceRow {
  id: string;
  name: string;
  normalized_url: string;
  interval_seconds: number;
  accepted_status_min: number;
  accepted_status_max: number;
  created_at: Date;
  updated_at: Date;
  next_check_at: Date;
  latest_scheduled_at: Date | null;
  latest_completed_at: Date | null;
  latest_outcome: CheckOutcome | null;
  latest_http_status: number | null;
  latest_response_time_ms: number | null;
  latest_duration_ms: number | null;
  latest_error_code: string | null;
}

const SERVICE_COLUMNS = `
  id, name, normalized_url, interval_seconds, accepted_status_min, accepted_status_max,
  created_at, updated_at, next_check_at, latest_scheduled_at, latest_completed_at,
  latest_outcome, latest_http_status, latest_response_time_ms, latest_duration_ms,
  latest_error_code
`;

function mapService(row: ServiceRow): ServiceRecord {
  return {
    id: row.id,
    name: row.name,
    normalizedUrl: row.normalized_url,
    intervalSeconds: row.interval_seconds,
    acceptedStatusMin: row.accepted_status_min,
    acceptedStatusMax: row.accepted_status_max,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextCheckAt: row.next_check_at,
    latestScheduledAt: row.latest_scheduled_at,
    latestCompletedAt: row.latest_completed_at,
    latestOutcome: row.latest_outcome,
    latestHttpStatus: row.latest_http_status,
    latestResponseTimeMs: row.latest_response_time_ms,
    latestDurationMs: row.latest_duration_ms,
    latestErrorCode: row.latest_error_code,
  };
}

export async function findServiceById(
  client: Pick<PoolClient, "query">,
  id: string,
): Promise<ServiceRecord | null> {
  const row = await queryOne<ServiceRow>(
    client,
    `SELECT ${SERVICE_COLUMNS} FROM services WHERE id = $1`,
    [id],
  );
  return row === null ? null : mapService(row);
}

export async function findServiceByNormalizedUrl(
  client: Pick<PoolClient, "query">,
  normalizedUrl: string,
): Promise<ServiceRecord | null> {
  const row = await queryOne<ServiceRow>(
    client,
    `SELECT ${SERVICE_COLUMNS} FROM services WHERE normalized_url = $1`,
    [normalizedUrl],
  );
  return row === null ? null : mapService(row);
}

export async function deleteService(client: Pick<PoolClient, "query">, id: string): Promise<boolean> {
  const result = await client.query("DELETE FROM services WHERE id = $1", [id]);
  return result.rowCount === 1;
}

export function hashCreateRequest(input: {
  name: string;
  normalizedUrl: string;
  intervalSeconds: number;
  acceptedStatusMin: number;
  acceptedStatusMax: number;
}): string {
  return createHash("sha256").update(canonicalCreateRequest(input)).digest("hex");
}

export interface CreateServiceInput {
  name: string;
  normalizedUrl: string;
  intervalSeconds: number;
  acceptedStatusMin: number;
  acceptedStatusMax: number;
  idempotencyKey: string;
  maxServices: number;
}

export type CreateServiceResult =
  | { kind: "created"; service: ServiceRecord }
  | { kind: "replayed"; service: ServiceRecord }
  | { kind: "duplicate" }
  | { kind: "capacity_reached" }
  | { kind: "idempotency_conflict" };

const CREATE_SERVICE_ADVISORY_LOCK = 7_921_403;

/**
 * Run inside the create request transaction. The transaction-wide advisory lock
 * makes the capacity count and insertion atomic across concurrent web workers.
 */
export async function createServiceWithIdempotency(
  client: Pick<PoolClient, "query">,
  input: CreateServiceInput,
): Promise<CreateServiceResult> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [CREATE_SERVICE_ADVISORY_LOCK]);

  const requestHash = hashCreateRequest(input);
  const existingRequest = await queryOne<{ request_hash: string; service_id: string }>(
    client,
    `
      SELECT request_hash, service_id
      FROM service_create_requests
      WHERE idempotency_key = $1 AND expires_at > now()
    `,
    [input.idempotencyKey],
  );
  if (existingRequest !== null) {
    if (existingRequest.request_hash !== requestHash) {
      return { kind: "idempotency_conflict" };
    }
    const service = await findServiceById(client, existingRequest.service_id);
    if (service !== null) {
      return { kind: "replayed", service };
    }
  }

  await client.query(
    "DELETE FROM service_create_requests WHERE idempotency_key = $1 AND expires_at <= now()",
    [input.idempotencyKey],
  );

  const existingService = await findServiceByNormalizedUrl(client, input.normalizedUrl);
  if (existingService !== null) {
    return { kind: "duplicate" };
  }

  const count = await queryOne<{ count: string }>(client, "SELECT count(*)::text AS count FROM services");
  if (Number(count?.count ?? 0) >= input.maxServices) {
    return { kind: "capacity_reached" };
  }

  const serviceRow = await queryOne<ServiceRow>(
    client,
    `
      INSERT INTO services (
        name, normalized_url, interval_seconds, accepted_status_min, accepted_status_max
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING ${SERVICE_COLUMNS}
    `,
    [
      input.name,
      input.normalizedUrl,
      input.intervalSeconds,
      input.acceptedStatusMin,
      input.acceptedStatusMax,
    ],
  );
  if (serviceRow === null) {
    throw new Error("Service insert did not return a row.");
  }

  await client.query(
    `
      INSERT INTO service_create_requests (idempotency_key, request_hash, service_id, expires_at)
      VALUES ($1, $2, $3, now() + interval '24 hours')
    `,
    [input.idempotencyKey, requestHash, serviceRow.id],
  );

  return { kind: "created", service: mapService(serviceRow) };
}
