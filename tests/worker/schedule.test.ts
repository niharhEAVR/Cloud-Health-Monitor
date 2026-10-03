import { describe, expect, it } from "vitest";

import { advanceSchedule, availableSlots } from "@/worker/schedule";

describe("worker scheduling", () => {
  it("preserves cadence when a check completes before the next slot", () => {
    const scheduledAt = new Date("2026-01-01T00:00:00.000Z");
    expect(advanceSchedule(scheduledAt, 60, new Date("2026-01-01T00:00:05.000Z"))).toEqual(
      new Date("2026-01-01T00:01:00.000Z"),
    );
  });

  it("skips missed slots rather than producing catch-up probes", () => {
    const scheduledAt = new Date("2026-01-01T00:00:00.000Z");
    expect(advanceSchedule(scheduledAt, 60, new Date("2026-01-01T00:03:01.000Z"))).toEqual(
      new Date("2026-01-01T00:04:00.000Z"),
    );
  });

  it("does not claim more work than the available concurrency slots", () => {
    expect(availableSlots(5, 0)).toBe(5);
    expect(availableSlots(5, 3)).toBe(2);
    expect(availableSlots(5, 5)).toBe(0);
    expect(availableSlots(5, 8)).toBe(0);
  });
});
