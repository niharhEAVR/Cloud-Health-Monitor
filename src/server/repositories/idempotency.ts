import "server-only";

import type { PoolClient } from "pg";

import { queryOne } from "@/server/db";

export interface CreateRequestRecord {
  idempotencyKey: string;
  requestHash: string;
  serviceId: string;
  expiresAt: Date;
}

interface CreateRequestRow {
  idempotency_key: string;
  request_hash: string;
  service_id: string;
  expires_at: Date;
}

export async function findCreateRequest(
  client: Pick<PoolClient, "query">,
  idempotencyKey: string,
): Promise<CreateRequestRecord | null> {
  const row = await queryOne<CreateRequestRow>(
    client,
    `
      SELECT idempotency_key, request_hash, service_id, expires_at
      FROM service_create_requests
      WHERE idempotency_key = $1 AND expires_at > now()
    `,
    [idempotencyKey],
  );
  if (row === null) {
    return null;
  }
  return {
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    serviceId: row.service_id,
    expiresAt: row.expires_at,
  };
}
