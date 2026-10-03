import type {
  DashboardData,
  HealthCheck,
  HistoryBucket,
  ServiceHistory,
  ServiceSummary,
} from "@/lib/monitor-types";

export class MonitorApiError extends Error {
  fieldErrors: Record<string, string[]> | undefined;

  constructor(message: string, fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = "MonitorApiError";
    this.fieldErrors = fieldErrors;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asCheck(value: unknown): HealthCheck | null {
  if (value === null || value === undefined) return null;
  const item = objectValue(value);
  const outcome = item.outcome === "up" ? "up" : item.outcome === "down" ? "down" : null;
  if (outcome === null) return null;
  return {
    id: stringValue(item.id),
    completedAt: stringValue(item.completedAt),
    outcome,
    httpStatus: numberOrNull(item.httpStatus),
    responseTimeMs: numberOrNull(item.responseTimeMs),
    durationMs: numberOrNull(item.durationMs),
    errorCode: typeof item.errorCode === "string" ? item.errorCode : null,
  };
}

function asBucket(value: unknown): HistoryBucket {
  const item = objectValue(value);
  return {
    startAt: stringValue(item.startAt),
    completedChecks: numberOrNull(item.completedChecks) ?? 0,
    acceptedChecks: numberOrNull(item.acceptedChecks) ?? 0,
    averageResponseTimeMs: numberOrNull(item.averageResponseTimeMs),
  };
}

export function asService(value: unknown): ServiceSummary {
  const item = objectValue(value);
  const latestCheck = asCheck(item.latestCheck);
  const rawHistory = Array.isArray(item.history) ? item.history : [];
  return {
    id: stringValue(item.id),
    name: stringValue(item.name),
    url: stringValue(item.url),
    intervalSeconds: numberOrNull(item.intervalSeconds) ?? 60,
    acceptedStatusMin: numberOrNull(item.acceptedStatusMin) ?? 200,
    acceptedStatusMax: numberOrNull(item.acceptedStatusMax) ?? 299,
    createdAt: stringValue(item.createdAt),
    status: ["up", "down", "pending", "stale"].includes(stringValue(item.status))
      ? (item.status as ServiceSummary["status"])
      : "pending",
    latestCheck,
    availability24h: numberOrNull(item.availability24h),
    history: rawHistory.map(asBucket),
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = objectValue(objectValue(body).error);
    throw new MonitorApiError(
      stringValue(error.message, "The request could not be completed. Please try again."),
      error.fieldErrors as Record<string, string[]> | undefined,
    );
  }
  return body as T;
}

export async function getDashboard(): Promise<DashboardData> {
  const body = objectValue(await request<unknown>("/api/services"));
  const worker = objectValue(body.worker);
  const counts = objectValue(body.counts);
  return {
    serverTime: stringValue(body.serverTime, new Date().toISOString()),
    workerDelayed: Boolean(worker.delayed ?? body.workerDelayed),
    workerLastHeartbeatAt: typeof worker.lastHeartbeatAt === "string" ? worker.lastHeartbeatAt : null,
    counts: {
      up: numberOrNull(counts.up) ?? 0,
      down: numberOrNull(counts.down) ?? 0,
      pending: numberOrNull(counts.pending) ?? 0,
      stale: numberOrNull(counts.stale) ?? 0,
    },
    services: (Array.isArray(body.services) ? body.services : []).map(asService),
  };
}

export async function getService(id: string): Promise<ServiceSummary> {
  return asService(await request<unknown>(`/api/services/${encodeURIComponent(id)}`));
}

export async function getHistory(id: string, range: string, cursor?: string): Promise<ServiceHistory> {
  const parameters = new URLSearchParams({ range, limit: "50" });
  if (cursor) parameters.set("cursor", cursor);
  const body = objectValue(await request<unknown>(`/api/services/${encodeURIComponent(id)}/history?${parameters}`));
  const rawChecks = Array.isArray(body.checks) ? body.checks : [];
  const rawBuckets = Array.isArray(body.buckets) ? body.buckets : [];
  return {
    range: (["24h", "7d", "30d", "90d"].includes(stringValue(body.range)) ? body.range : range) as ServiceHistory["range"],
    asOf: stringValue(body.asOf, new Date().toISOString()),
    availability: numberOrNull(body.availability),
    buckets: rawBuckets.map(asBucket),
    checks: rawChecks.map(asCheck).filter((check): check is HealthCheck => check !== null),
    nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null,
  };
}

export async function createService(input: Record<string, unknown>): Promise<ServiceSummary> {
  const idempotencyKey = crypto.randomUUID();
  return asService(
    await request<unknown>("/api/services", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  );
}

export async function removeService(id: string): Promise<void> {
  await request<unknown>(`/api/services/${encodeURIComponent(id)}`, { method: "DELETE" });
}
