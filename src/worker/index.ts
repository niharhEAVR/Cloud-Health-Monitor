import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { Pool } from "pg";

import { parseWorkerEnv, PROBE_DEADLINE_MS, type WorkerEnv } from "./config.js";
import { boundedErrorCode, createLogger, redactTargetUrl, type WorkerLogger } from "./log.js";
import { probeHttp, type ProbeDependencies } from "./probe.js";
import {
  claimDueServices,
  persistCompletedProbe,
  releaseWorkerLeases,
  runRetentionCleanup,
  writeHeartbeat,
  writeSchedulerPass,
  type ClaimedService,
  type CompletedProbe,
} from "./repository.js";
import { availableSlots } from "./schedule.js";

export class WorkerRuntime {
  private readonly workerId = randomUUID();
  private readonly active = new Map<Promise<void>, AbortController>();
  private readonly logger: WorkerLogger;
  private readonly pool: Pool;
  private schedulerRunning = false;
  private stopping = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private retentionTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: WorkerEnv,
    options: { pool?: Pool; logger?: WorkerLogger; probeDependencies?: ProbeDependencies } = {},
  ) {
    this.pool = options.pool ?? new Pool({
      connectionString: config.DATABASE_URL,
      connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      max: config.DATABASE_POOL_MAX,
      options: `-c statement_timeout=${config.DATABASE_STATEMENT_TIMEOUT_MS} -c lock_timeout=5000`,
    });
    this.logger = options.logger ?? createLogger(config);
    this.probeDependencies = options.probeDependencies;
    this.pool.on("error", (error) => this.logger("error", "worker.database.idle_client_error", {
      errorCode: boundedErrorCode(error),
    }));
  }

  private readonly probeDependencies: ProbeDependencies | undefined;

  async start(): Promise<void> {
    this.logger("info", "worker.started", { workerId: this.workerId, concurrency: this.config.WORKER_CONCURRENCY });
    await this.heartbeat();
    if (this.stopping) return;
    await this.cleanup();
    if (this.stopping) return;
    await this.tick();
    if (this.stopping) return;
    this.pollTimer = setInterval(() => void this.tick(), this.config.WORKER_POLL_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 10_000);
    this.retentionTimer = setInterval(() => void this.cleanup(), 60 * 60 * 1_000);
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.clearTimers();
    this.logger("info", "worker.stopping", { workerId: this.workerId, inFlight: this.active.size });

    await this.waitForActiveWork(this.config.WORKER_SHUTDOWN_GRACE_MS);
    for (const controller of this.active.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.active.keys()]);
    try {
      const released = await releaseWorkerLeases(this.pool, this.workerId);
      this.logger("info", "worker.leases_released", { workerId: this.workerId, released });
    } finally {
      await this.pool.end();
    }
    this.logger("info", "worker.stopped", { workerId: this.workerId });
  }

  private clearTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
    this.retentionTimer = undefined;
  }

  private async waitForActiveWork(graceMs: number): Promise<void> {
    const current = [...this.active.keys()];
    if (current.length === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      void Promise.allSettled(current).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.schedulerRunning) {
      return;
    }
    this.schedulerRunning = true;
    try {
      const slots = availableSlots(this.config.WORKER_CONCURRENCY, this.active.size);
      if (slots === 0) {
        await writeSchedulerPass(this.pool, this.workerId);
        return;
      }
      const claims = await claimDueServices(this.pool, this.workerId, slots, this.config.WORKER_LEASE_SECONDS);
      await writeSchedulerPass(this.pool, this.workerId);
      for (const claim of claims) {
        if (this.stopping) {
          break;
        }
        this.trackClaim(claim);
      }
    } catch (error) {
      this.logger("error", "worker.scheduler_failed", { workerId: this.workerId, errorCode: boundedErrorCode(error) });
    } finally {
      this.schedulerRunning = false;
    }
  }

  private trackClaim(claim: ClaimedService): void {
    const controller = new AbortController();
    const task = this.runClaim(claim, controller)
      .catch(() => undefined)
      .finally(() => this.active.delete(task));
    this.active.set(task, controller);
  }

  private async runClaim(claim: ClaimedService, controller: AbortController): Promise<void> {
    const startedAt = performance.now();
    const probe = await probeHttp(claim.normalizedUrl, PROBE_DEADLINE_MS, {
      ...this.probeDependencies,
      signal: controller.signal,
    });
    // Continue persisting a completed probe during graceful shutdown. Only an
    // explicit post-grace abort drops an unfinished request.
    if (controller.signal.aborted) {
      return;
    }
    const result: CompletedProbe = probe.ok
      ? {
          outcome: probe.httpStatus >= claim.acceptedStatusMin && probe.httpStatus <= claim.acceptedStatusMax ? "up" : "down",
          httpStatus: probe.httpStatus,
          responseTimeMs: probe.responseTimeMs,
          totalDurationMs: probe.totalDurationMs,
          errorCode: probe.httpStatus >= claim.acceptedStatusMin && probe.httpStatus <= claim.acceptedStatusMax ? null : "HTTP_STATUS",
        }
      : {
          outcome: "down",
          httpStatus: null,
          responseTimeMs: null,
          totalDurationMs: probe.totalDurationMs,
          errorCode: probe.errorCode,
        };
    try {
      const persisted = await persistCompletedProbe(this.pool, claim, result);
      this.logger("info", "worker.probe_completed", {
        workerId: this.workerId,
        serviceId: claim.id,
        target: redactTargetUrl(claim.normalizedUrl),
        outcome: result.outcome,
        errorCode: result.errorCode ?? undefined,
        httpStatus: result.httpStatus ?? undefined,
        durationMs: Math.round(performance.now() - startedAt),
        persistence: persisted,
      });
    } catch (error) {
      this.logger("error", "worker.probe_persistence_failed", {
        workerId: this.workerId,
        serviceId: claim.id,
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: boundedErrorCode(error),
      });
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.stopping) return;
    try {
      await writeHeartbeat(this.pool, this.workerId);
    } catch (error) {
      this.logger("error", "worker.heartbeat_failed", { workerId: this.workerId, errorCode: boundedErrorCode(error) });
    }
  }

  private async cleanup(): Promise<void> {
    if (this.stopping) return;
    try {
      const counts = await runRetentionCleanup(this.pool);
      if (counts) {
        this.logger("info", "worker.retention_completed", { workerId: this.workerId, ...counts });
      }
    } catch (error) {
      this.logger("warn", "worker.retention_failed", { workerId: this.workerId, errorCode: boundedErrorCode(error) });
    }
  }
}

async function main(): Promise<void> {
  const runtime = new WorkerRuntime(parseWorkerEnv());
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ??= runtime.stop();
    return stopPromise;
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  await runtime.start();
}

if (process.env.VITEST !== "true") {
  void main().catch((error: unknown) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(), level: "error", event: "worker.fatal", errorCode: boundedErrorCode(error),
    }));
    process.exitCode = 1;
  });
}
