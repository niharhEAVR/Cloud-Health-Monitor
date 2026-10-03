import { describe, expect, it } from "vitest";

import { calculateAvailability, deriveDisplayStatus, isAcceptedStatus, staleAfterMs } from "@/shared/status";

describe("health status semantics", () => {
  const now = new Date("2026-10-03T10:00:00.000Z");

  it("uses a minimum one-minute staleness threshold", () => {
    expect(staleAfterMs(30)).toBe(60_000);
    expect(staleAfterMs(120)).toBe(240_000);
  });

  it("keeps a result fresh at the exact staleness boundary", () => {
    expect(
      deriveDisplayStatus({ completedAt: new Date("2026-10-03T09:59:00.000Z"), outcome: "up" }, 30, now),
    ).toBe("up");
  });

  it("marks an older result stale without changing its recorded outcome", () => {
    expect(
      deriveDisplayStatus({ completedAt: new Date("2026-10-03T09:58:59.999Z"), outcome: "down" }, 30, now),
    ).toBe("stale");
  });

  it("returns pending before a first completed check and stale once overdue", () => {
    expect(deriveDisplayStatus({ completedAt: null, outcome: null }, 60, now, new Date("2026-10-03T09:59:00.000Z"))).toBe(
      "pending",
    );
    expect(deriveDisplayStatus({ completedAt: null, outcome: null }, 60, now, new Date("2026-10-03T09:57:59.999Z"))).toBe(
      "stale",
    );
  });

  it("calculates availability from completed checks only", () => {
    expect(calculateAvailability(9, 12)).toBe(0.75);
    expect(calculateAvailability(0, 0)).toBeNull();
    expect(isAcceptedStatus(299, 200, 299)).toBe(true);
    expect(isAcceptedStatus(300, 200, 299)).toBe(false);
  });
});
