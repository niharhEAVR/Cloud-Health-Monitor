import type { CheckOutcome, DisplayStatus } from "@/shared/contracts";

export interface LatestCheckSnapshot {
  completedAt: Date | null;
  outcome: CheckOutcome | null;
}

export function staleAfterMs(intervalSeconds: number): number {
  return Math.max(intervalSeconds * 2_000, 60_000);
}

export function deriveDisplayStatus(
  latestCheck: LatestCheckSnapshot,
  intervalSeconds: number,
  now: Date,
  createdAt?: Date,
): DisplayStatus {
  const observationAt = latestCheck.completedAt ?? createdAt;
  if (observationAt === undefined) {
    return "pending";
  }

  if (now.getTime() - observationAt.getTime() > staleAfterMs(intervalSeconds)) {
    return "stale";
  }

  return latestCheck.outcome ?? "pending";
}

export function isAcceptedStatus(
  httpStatus: number,
  acceptedStatusMin: number,
  acceptedStatusMax: number,
): boolean {
  return httpStatus >= acceptedStatusMin && httpStatus <= acceptedStatusMax;
}

export function calculateAvailability(acceptedChecks: number, completedChecks: number): number | null {
  if (completedChecks === 0) {
    return null;
  }
  return acceptedChecks / completedChecks;
}
