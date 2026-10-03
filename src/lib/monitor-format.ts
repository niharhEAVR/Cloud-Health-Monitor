import type { DisplayStatus, HealthCheck, HistoryBucket } from "@/lib/monitor-types";

const labels: Record<DisplayStatus, string> = {
  up: "Operational",
  down: "Down",
  pending: "Waiting",
  stale: "Stale",
};

export function statusLabel(status: DisplayStatus): string {
  return labels[status];
}

export function formatAvailability(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(value * 100 >= 99.95 ? 0 : 2)}%`;
}

export function formatDuration(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value)} ms`;
}

export function formatRelativeTime(value: string | null, now = Date.now()): string {
  if (!value) return "No completed check";
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function checkResult(check: HealthCheck | null): string {
  if (!check) return "First check has not completed";
  if (check.httpStatus !== null) return `HTTP ${check.httpStatus}`;
  return check.errorCode ? check.errorCode.replaceAll("_", " ") : "Connection failed";
}

export function bucketState(bucket: HistoryBucket): "up" | "down" | "none" {
  if (bucket.completedChecks === 0) return "none";
  return bucket.completedChecks === bucket.acceptedChecks ? "up" : "down";
}
