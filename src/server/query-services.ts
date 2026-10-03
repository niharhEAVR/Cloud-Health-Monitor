import "server-only";

import { getPool, queryOne, withTransaction } from "@/server/db";
import { AppError } from "@/server/errors";
import { parseServerEnv } from "@/server/env";
import {
  createServiceWithIdempotency,
  deleteService,
  findServiceById,
  type CreateServiceInput,
  type ServiceRecord,
} from "@/server/repositories/services";
import { calculateAvailability, deriveDisplayStatus } from "@/shared/status";
import { ServiceIdSchema, type DisplayStatus } from "@/shared/contracts";

const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const WORKER_FRESH_MS = 30 * 1_000;

export interface CheckView {
  scheduledAt: string;
  completedAt: string;
  outcome: "up" | "down";
  httpStatus: number | null;
  responseTimeMs: number | null;
  durationMs: number;
  errorCode: string | null;
}

export interface ServiceSummary {
  id: string;
  name: string;
  url: string;
  intervalSeconds: number;
  acceptedStatusMin: number;
  acceptedStatusMax: number;
  createdAt: string;
  updatedAt: string;
  nextCheckAt: string;
  status: DisplayStatus;
  latestCheck: CheckView | null;
  lastCheck: CheckView | null;
  availability24h: number | null;
  history: HistoryBucket[];
  compactHistory: HistoryBucket[];
}

export interface HistoryBucket {
  startAt: string;
  startsAt: string;
  endsAt: string;
  completedChecks: number;
  acceptedChecks: number;
  availability: number | null;
  averageResponseTimeMs: number | null;
}

export interface WorkerSummary {
  lastSeenAt: string | null;
  schedulerRanAt: string | null;
  isFresh: boolean;
}

interface AvailabilityRow {
  service_id: string;
  completed_checks: string;
  accepted_checks: string;
}

interface CompactBucketRow {
  service_id: string;
  hour_start: Date;
  completed_checks: string;
  accepted_checks: string;
  response_time_count: string;
  response_time_sum_ms: string;
}

interface WorkerRow {
  last_seen_at: Date | null;
  scheduler_ran_at: Date | null;
}

interface CheckRow {
  id: string;
  scheduled_at: Date;
  completed_at: Date;
  outcome: "up" | "down";
  http_status: number | null;
  response_time_ms: number | null;
  total_duration_ms: number;
  error_code: string | null;
}

function iso(value: Date): string {
  return value.toISOString();
}

function lastCheck(service: ServiceRecord): CheckView | null {
  if (service.latestCompletedAt === null || service.latestOutcome === null || service.latestScheduledAt === null) {
    return null;
  }
  return {
    scheduledAt: iso(service.latestScheduledAt),
    completedAt: iso(service.latestCompletedAt),
    outcome: service.latestOutcome,
    httpStatus: service.latestHttpStatus,
    responseTimeMs: service.latestResponseTimeMs,
    durationMs: service.latestDurationMs ?? 0,
    errorCode: service.latestErrorCode,
  };
}

function mapSummary(
  service: ServiceRecord,
  now: Date,
  availability24h: number | null,
  compactHistory: HistoryBucket[],
): ServiceSummary {
  return {
    id: service.id,
    name: service.name,
    url: service.normalizedUrl,
    intervalSeconds: service.intervalSeconds,
    acceptedStatusMin: service.acceptedStatusMin,
    acceptedStatusMax: service.acceptedStatusMax,
    createdAt: iso(service.createdAt),
    updatedAt: iso(service.updatedAt),
    nextCheckAt: iso(service.nextCheckAt),
    status: deriveDisplayStatus(
      { completedAt: service.latestCompletedAt, outcome: service.latestOutcome },
      service.intervalSeconds,
      now,
      service.createdAt,
    ),
    latestCheck: lastCheck(service),
    lastCheck: lastCheck(service),
    availability24h,
    history: compactHistory,
    compactHistory,
  };
}

async function availabilityByService(serviceIds: string[], now: Date): Promise<Map<string, number | null>> {
  const availability = new Map<string, number | null>();
  if (serviceIds.length === 0) return availability;
  const result = await getPool().query<AvailabilityRow>(
    `
      SELECT service_id, count(*)::text AS completed_checks,
             count(*) FILTER (WHERE outcome = 'up')::text AS accepted_checks
      FROM health_checks
      WHERE service_id = ANY($1::uuid[]) AND completed_at >= $2 AND completed_at <= $3
      GROUP BY service_id
    `,
    [serviceIds, new Date(now.getTime() - HISTORY_WINDOW_MS), now],
  );
  for (const row of result.rows) {
    availability.set(row.service_id, calculateAvailability(Number(row.accepted_checks), Number(row.completed_checks)));
  }
  return availability;
}

async function compactHistoryByService(serviceIds: string[], now: Date): Promise<Map<string, HistoryBucket[]>> {
  const histories = new Map<string, HistoryBucket[]>();
  if (serviceIds.length === 0) return histories;
  const since = new Date(now.getTime() - HISTORY_WINDOW_MS);
  const result = await getPool().query<CompactBucketRow>(
    `
      SELECT service_id, date_trunc('hour', completed_at) AS hour_start,
             count(*)::text AS completed_checks,
             count(*) FILTER (WHERE outcome = 'up')::text AS accepted_checks,
             count(response_time_ms)::text AS response_time_count,
             coalesce(sum(response_time_ms), 0)::text AS response_time_sum_ms
      FROM health_checks
      WHERE service_id = ANY($1::uuid[]) AND completed_at >= $2 AND completed_at <= $3
      GROUP BY service_id, date_trunc('hour', completed_at)
      ORDER BY service_id, hour_start
    `,
    [serviceIds, since, now],
  );
  for (const row of result.rows) {
    const completedChecks = Number(row.completed_checks);
    const responseTimeCount = Number(row.response_time_count);
    const bucket: HistoryBucket = {
      startAt: iso(row.hour_start),
      startsAt: iso(row.hour_start),
      endsAt: iso(new Date(row.hour_start.getTime() + 60 * 60 * 1_000)),
      completedChecks,
      acceptedChecks: Number(row.accepted_checks),
      availability: calculateAvailability(Number(row.accepted_checks), completedChecks),
      averageResponseTimeMs: responseTimeCount === 0 ? null : Number(row.response_time_sum_ms) / responseTimeCount,
    };
    const current = histories.get(row.service_id) ?? [];
    current.push(bucket);
    histories.set(row.service_id, current);
  }
  return histories;
}

export async function getWorkerSummary(now = new Date()): Promise<WorkerSummary> {
  const row = await queryOne<WorkerRow>(
    getPool(),
    `
      SELECT max(last_seen_at) AS last_seen_at, max(scheduler_ran_at) AS scheduler_ran_at
      FROM worker_heartbeats
    `,
  );
  const lastSeenAt = row?.last_seen_at ?? null;
  return {
    lastSeenAt: lastSeenAt === null ? null : iso(lastSeenAt),
    schedulerRanAt: row?.scheduler_ran_at === null || row?.scheduler_ran_at === undefined ? null : iso(row.scheduler_ran_at),
    isFresh: lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() <= WORKER_FRESH_MS,
  };
}

export async function getServiceSummaries(now = new Date()): Promise<ServiceSummary[]> {
  const maxServices = parseServerEnv().MAX_SERVICES;
  const result = await getPool().query(
    `SELECT id FROM services ORDER BY name ASC, id ASC LIMIT $1`,
    [maxServices],
  );
  const services = await Promise.all(result.rows.map((row) => findServiceById(getPool(), row.id)));
  const records = services.filter((service): service is ServiceRecord => service !== null);
  const ids = records.map((service) => service.id);
  const [availability, histories] = await Promise.all([availabilityByService(ids, now), compactHistoryByService(ids, now)]);
  return records.map((service) => mapSummary(service, now, availability.get(service.id) ?? null, histories.get(service.id) ?? []));
}

export async function getServiceSummary(id: string, now = new Date()): Promise<ServiceSummary | null> {
  const service = await findServiceById(getPool(), id);
  if (service === null) return null;
  const [availability, histories] = await Promise.all([
    availabilityByService([id], now),
    compactHistoryByService([id], now),
  ]);
  return mapSummary(service, now, availability.get(id) ?? null, histories.get(id) ?? []);
}

export async function createService(input: CreateServiceInput): Promise<{ created: boolean; service: ServiceSummary }> {
  const result = await withTransaction((client) => createServiceWithIdempotency(client, input));
  if (result.kind === "idempotency_conflict") {
    throw new AppError({ code: "IDEMPOTENCY_CONFLICT", message: "Idempotency-Key was already used for a different request.", status: 409 });
  }
  if (result.kind === "duplicate") {
    throw new AppError({ code: "CONFLICT", message: "A service with this URL already exists.", status: 409 });
  }
  if (result.kind === "capacity_reached") {
    throw new AppError({ code: "SERVICE_LIMIT_REACHED", message: "The configured service limit has been reached.", status: 409 });
  }
  return {
    created: result.kind === "created",
    service: mapSummary(result.service, new Date(), null, []),
  };
}

export async function removeService(id: string): Promise<void> {
  await withTransaction((client) => deleteService(client, id));
}

export interface ExactCheck extends CheckView {
  id: string;
}

export interface HistoryPage {
  asOf: string;
  from: string;
  buckets: HistoryBucket[];
  checks: ExactCheck[];
  nextCursor: string | null;
}

interface HistoryCursor {
  serviceId: string;
  range: string;
  asOf: string;
  beforeCompletedAt: string;
  beforeId: string;
}

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function parseHistoryCursor(value: string, serviceId: string, range: string): HistoryCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" || parsed === null ||
      !("serviceId" in parsed) || !("range" in parsed) || !("asOf" in parsed) ||
      !("beforeCompletedAt" in parsed) || !("beforeId" in parsed) ||
      parsed.serviceId !== serviceId || parsed.range !== range ||
      typeof parsed.asOf !== "string" || typeof parsed.beforeCompletedAt !== "string" || typeof parsed.beforeId !== "string" ||
      Number.isNaN(Date.parse(parsed.asOf)) || Number.isNaN(Date.parse(parsed.beforeCompletedAt)) ||
      !ServiceIdSchema.safeParse(parsed.beforeId).success
    ) {
      throw new Error("Invalid cursor");
    }
    return parsed as HistoryCursor;
  } catch {
    throw new AppError({ code: "VALIDATION_ERROR", message: "Cursor is invalid.", status: 422, fieldErrors: { cursor: ["Cursor is invalid."] } });
  }
}

function rangeMilliseconds(range: string): number {
  return { "24h": 24, "7d": 7 * 24, "30d": 30 * 24, "90d": 90 * 24 }[range]! * 60 * 60 * 1_000;
}

function bucketMilliseconds(range: string): number {
  return range === "24h" || range === "7d" ? 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
}

function floorBucket(date: Date, size: number): Date {
  return new Date(Math.floor(date.getTime() / size) * size);
}

/** History has an anchor timestamp carried through every cursor, preventing new checks from moving later pages. */
export async function getHistoryPage(options: {
  serviceId: string;
  range: string;
  pageSize: number;
  cursor?: HistoryCursor;
  now?: Date;
}): Promise<HistoryPage | null> {
  const service = await findServiceById(getPool(), options.serviceId);
  if (service === null) return null;
  const asOf = options.cursor === undefined ? options.now ?? new Date() : new Date(options.cursor.asOf);
  const from = new Date(asOf.getTime() - rangeMilliseconds(options.range));
  const size = bucketMilliseconds(options.range);
  const bucketStart = floorBucket(from, size);
  const bucketResult = await getPool().query<CompactBucketRow>(
    `
      SELECT service_id, date_trunc($4, completed_at) AS hour_start,
             count(*)::text AS completed_checks,
             count(*) FILTER (WHERE outcome = 'up')::text AS accepted_checks,
             count(response_time_ms)::text AS response_time_count,
             coalesce(sum(response_time_ms), 0)::text AS response_time_sum_ms
      FROM health_checks
      WHERE service_id = $1 AND completed_at >= $2 AND completed_at <= $3
      GROUP BY service_id, date_trunc($4, completed_at)
      ORDER BY hour_start ASC
    `,
    [options.serviceId, from, asOf, size === 60 * 60 * 1_000 ? "hour" : "day"],
  );
  const rowsByStart = new Map(bucketResult.rows.map((row) => [row.hour_start.getTime(), row]));
  const buckets: HistoryBucket[] = [];
  for (let start = bucketStart.getTime(); start <= asOf.getTime(); start += size) {
    const row = rowsByStart.get(start);
    const completedChecks = Number(row?.completed_checks ?? 0);
    const acceptedChecks = Number(row?.accepted_checks ?? 0);
    const responseTimeCount = Number(row?.response_time_count ?? 0);
    buckets.push({
      startAt: iso(new Date(start)),
      startsAt: iso(new Date(start)),
      endsAt: iso(new Date(start + size)),
      completedChecks,
      acceptedChecks,
      availability: calculateAvailability(acceptedChecks, completedChecks),
      averageResponseTimeMs: responseTimeCount === 0 ? null : Number(row?.response_time_sum_ms ?? 0) / responseTimeCount,
    });
  }

  const checkResult = await getPool().query<CheckRow>(
    `
      SELECT id, scheduled_at, completed_at, outcome, http_status, response_time_ms, total_duration_ms, error_code
      FROM health_checks
      WHERE service_id = $1 AND completed_at >= $2 AND completed_at <= $3
        AND ($4::timestamptz IS NULL OR (completed_at, id) < ($4::timestamptz, $5::uuid))
      ORDER BY completed_at DESC, id DESC
      LIMIT $6
    `,
    [options.serviceId, from, asOf, options.cursor?.beforeCompletedAt ?? null, options.cursor?.beforeId ?? null, options.pageSize + 1],
  );
  const hasMore = checkResult.rows.length > options.pageSize;
  const pageRows = checkResult.rows.slice(0, options.pageSize);
  const last = pageRows.at(-1);
  return {
    asOf: iso(asOf),
    from: iso(from),
    buckets,
    checks: pageRows.map((row) => ({
      id: row.id,
      scheduledAt: iso(row.scheduled_at),
      completedAt: iso(row.completed_at),
      outcome: row.outcome,
      httpStatus: row.http_status,
      responseTimeMs: row.response_time_ms,
      durationMs: row.total_duration_ms,
      errorCode: row.error_code,
    })),
    nextCursor: hasMore && last !== undefined
      ? encodeCursor({ serviceId: options.serviceId, range: options.range, asOf: iso(asOf), beforeCompletedAt: iso(last.completed_at), beforeId: last.id })
      : null,
  };
}
