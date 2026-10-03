// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateServiceForm } from "@/components/create-service-form";
import { DeleteServiceDialog } from "@/components/delete-service-dialog";
import { AppHeader, HistoryStrip } from "@/components/monitor-ui";
import { MonitorApiError } from "@/lib/monitor-api";
import { ServiceDetail } from "@/components/service-detail";

const push = vi.fn();
const createService = vi.fn();
const removeService = vi.fn();
const getService = vi.fn();
const getHistory = vi.fn();

vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/monitor-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/monitor-api")>();
  return { ...actual, createService: (...args: unknown[]) => createService(...args), removeService: (...args: unknown[]) => removeService(...args), getService: (...args: unknown[]) => getService(...args), getHistory: (...args: unknown[]) => getHistory(...args) };
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("monitor UI accessibility", () => {
  it("uses an explicit unavailable worker label and meaningful history alternative", () => {
    render(<><AppHeader /><HistoryStrip label="API 24-hour history" buckets={[{ startAt: "2026-01-01T00:00:00Z", completedChecks: 2, acceptedChecks: 1, averageResponseTimeMs: 30 }]} /></>);
    expect(screen.getByText("Worker status unavailable")).toBeTruthy();
    expect(screen.getByRole("img", { name: /one or more rejected checks/i })).toBeTruthy();
  });

  it("traps dialog focus, closes with Escape, and restores the trigger focus", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Open delete</button>{open ? <DeleteServiceDialog service={{ id: "svc", name: "API", url: "https://api.example.com" }} onClose={() => setOpen(false)} onDeleted={() => setOpen(false)} /> : null}</>;
    }
    render(<Host />);
    const trigger = screen.getByRole("button", { name: "Open delete" });
    trigger.focus(); fireEvent.click(trigger);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const remove = screen.getByRole("button", { name: "Delete service" });
    expect(document.activeElement).toBe(cancel);
    remove.focus();
    fireEvent.keyDown(document, { key: "Tab" }); expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps one idempotency key while retrying the same create payload and surfaces interval errors", async () => {
    createService.mockRejectedValue(new MonitorApiError("Fix the interval.", 400, { intervalSeconds: ["Choose a value between 30 and 86400 seconds."] }));
    render(<CreateServiceForm />);
    const submit = screen.getByRole("button", { name: "Create service" });
    fireEvent.click(submit);
    await screen.findByText("Fix the interval.");
    expect(screen.getAllByText("Choose a value between 30 and 86400 seconds.")).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    const firstKey = createService.mock.calls[0]?.[1];
    fireEvent.click(submit);
    await waitFor(() => expect(createService).toHaveBeenCalledTimes(2));
    expect(createService.mock.calls[1]?.[1]).toBe(firstKey);
  });

  it("polls a pending detail view and updates it when a check completes", async () => {
    vi.useFakeTimers();
    const pending = { id: "svc", name: "API", url: "https://api.example.com", intervalSeconds: 60, acceptedStatusMin: 200, acceptedStatusMax: 299, createdAt: "2026-01-01T00:00:00Z", status: "pending", latestCheck: null, availability24h: null, history: [] };
    const operational = { ...pending, status: "up", latestCheck: { id: "check", completedAt: "2026-01-01T00:01:00Z", outcome: "up", httpStatus: 200, responseTimeMs: 25, durationMs: 25, errorCode: null } };
    const emptyHistory = { range: "24h", asOf: "2026-01-01T00:01:00Z", availability: null, buckets: [], checks: [], nextCursor: null };
    getService.mockResolvedValueOnce(pending).mockResolvedValueOnce(operational);
    getHistory.mockResolvedValue(emptyHistory);
    render(<ServiceDetail id="svc" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getAllByText("Waiting", { exact: true }).length).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getAllByText("Operational", { exact: true }).length).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
