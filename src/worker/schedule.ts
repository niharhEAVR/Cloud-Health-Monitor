export function advanceSchedule(
  scheduledAt: Date,
  intervalSeconds: number,
  completedAt: Date,
): Date {
  const intervalMs = intervalSeconds * 1_000;
  const elapsedMs = completedAt.getTime() - scheduledAt.getTime();
  const intervalsToAdvance = Math.max(1, Math.floor(elapsedMs / intervalMs) + 1);
  return new Date(scheduledAt.getTime() + intervalsToAdvance * intervalMs);
}

export function availableSlots(concurrency: number, activeCount: number): number {
  return Math.max(0, concurrency - activeCount);
}
