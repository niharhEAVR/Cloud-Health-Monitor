import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDueServices: vi.fn(),
  persistCompletedProbe: vi.fn(),
  releaseWorkerLeases: vi.fn(),
  runRetentionCleanup: vi.fn(),
  writeHeartbeat: vi.fn(),
  writeSchedulerPass: vi.fn(),
}));

vi.mock("@/worker/repository", () => ({
  ...mocks,
}));

import { WorkerRuntime } from "@/worker/index";

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
}

const workerConfig = {
  DATABASE_URL: "postgres://worker:worker@localhost:5432/worker",
  LOG_LEVEL: "error" as const,
  DATABASE_POOL_MAX: 5,
  DATABASE_CONNECTION_TIMEOUT_MS: 5_000,
  DATABASE_STATEMENT_TIMEOUT_MS: 10_000,
  WORKER_CONCURRENCY: 5,
  WORKER_LEASE_SECONDS: 45,
  WORKER_POLL_INTERVAL_MS: 1_000,
  WORKER_SHUTDOWN_GRACE_MS: 100,
  NODE_ENV: "test" as const,
};

describe("worker shutdown coordination", () => {
  it("waits for an in-flight scheduler claim before releasing this worker's leases", async () => {
    const schedulerClaim = deferred<[]>();
    mocks.claimDueServices.mockReturnValueOnce(schedulerClaim.promise);
    mocks.writeHeartbeat.mockResolvedValue(undefined);
    mocks.runRetentionCleanup.mockResolvedValue(null);
    mocks.writeSchedulerPass.mockResolvedValue(undefined);
    mocks.releaseWorkerLeases.mockResolvedValue(0);
    const pool = { on: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
    const runtime = new WorkerRuntime(workerConfig, { pool: pool as never, logger: vi.fn() });

    const starting = runtime.start();
    await vi.waitFor(() => expect(mocks.claimDueServices).toHaveBeenCalledOnce());
    const stopping = runtime.stop();
    await Promise.resolve();
    expect(mocks.releaseWorkerLeases).not.toHaveBeenCalled();

    schedulerClaim.resolve([]);
    await Promise.all([starting, stopping]);

    expect(mocks.writeSchedulerPass).toHaveBeenCalledBefore(mocks.releaseWorkerLeases);
    expect(mocks.releaseWorkerLeases).toHaveBeenCalledOnce();
  });

  it("stays bounded and leaves leases to expire when a scheduler tick misses the deadline", async () => {
    const schedulerClaim = deferred<[]>();
    mocks.claimDueServices.mockReturnValueOnce(schedulerClaim.promise);
    mocks.writeHeartbeat.mockResolvedValue(undefined);
    mocks.runRetentionCleanup.mockResolvedValue(null);
    const pool = { on: vi.fn(), end: vi.fn().mockResolvedValue(undefined) };
    const runtime = new WorkerRuntime(workerConfig, { pool: pool as never, logger: vi.fn() });

    const starting = runtime.start();
    await vi.waitFor(() => expect(mocks.claimDueServices).toHaveBeenCalledOnce());
    await expect(runtime.stop()).resolves.toBeUndefined();

    expect(mocks.releaseWorkerLeases).not.toHaveBeenCalled();
    schedulerClaim.resolve([]);
    await starting;
  });
});
