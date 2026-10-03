import { describe, expect, it } from "vitest";

import { bucketState, formatAvailability, statusLabel } from "@/lib/monitor-format";

describe("frontend display helpers", () => {
  it("does not imply availability when no completed checks exist", () => { expect(formatAvailability(null)).toBe("—"); });
  it("labels operational state without relying on colour", () => { expect(statusLabel("up")).toBe("Operational"); expect(statusLabel("stale")).toBe("Stale"); });
  it("marks empty history buckets separately from failures", () => { expect(bucketState({ startAt: "2026-01-01T00:00:00Z", completedChecks: 0, acceptedChecks: 0, averageResponseTimeMs: null })).toBe("none"); });
});
