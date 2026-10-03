export type DisplayStatus = "up" | "down" | "pending" | "stale";
export type HistoryRange = "24h" | "7d" | "30d" | "90d";

export interface HistoryBucket {
  startAt: string;
  completedChecks: number;
  acceptedChecks: number;
  averageResponseTimeMs: number | null;
}

export interface HealthCheck {
  id: string;
  completedAt: string;
  outcome: "up" | "down";
  httpStatus: number | null;
  responseTimeMs: number | null;
  durationMs: number | null;
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
  status: DisplayStatus;
  latestCheck: HealthCheck | null;
  availability24h: number | null;
  history: HistoryBucket[];
}

export interface DashboardData {
  serverTime: string;
  workerDelayed: boolean;
  workerLastHeartbeatAt: string | null;
  counts: Record<DisplayStatus, number>;
  services: ServiceSummary[];
}

export interface ServiceHistory {
  range: HistoryRange;
  asOf: string;
  availability: number | null;
  buckets: HistoryBucket[];
  checks: HealthCheck[];
  nextCursor: string | null;
}

export interface ApiProblem {
  message: string;
  fieldErrors?: Record<string, string[]>;
}
