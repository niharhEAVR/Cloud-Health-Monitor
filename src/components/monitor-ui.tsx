import Link from "next/link";
import type { ReactNode } from "react";

import { bucketState, statusLabel } from "@/lib/monitor-format";
import type { DisplayStatus, HistoryBucket } from "@/lib/monitor-types";

type WorkerState = "online" | "delayed" | "unknown";

export function AppHeader({ workerState = "unknown" }: { workerState?: WorkerState }) {
  const label = workerState === "online" ? "Worker online" : workerState === "delayed" ? "Worker delayed" : "Worker status unavailable";
  return (
    <header className="topbar">
      <Link className="brand" href="/" aria-label="Cloud Health Monitor dashboard">
        <span className="logo" aria-hidden="true"><i /><i /><i /></span>
        <span>Cloud Health Monitor</span>
      </Link>
      <span className={`worker-state ${workerState}`}>
        <i aria-hidden="true" />{label}
      </span>
    </header>
  );
}

export function StatusBadge({ status }: { status: DisplayStatus }) {
  return <span className={`status-badge ${status}`}><i aria-hidden="true" />{statusLabel(status)}</span>;
}

export function HistoryStrip({ buckets, label }: { buckets: HistoryBucket[]; label: string }) {
  const visible = buckets.slice(-24);
  const stateWords = visible.map(bucketState);
  return (
    <div className="history-strip" role="img" aria-label={`${label}: ${stateWords.filter((state) => state === "up").length} time buckets with all completed checks accepted, ${stateWords.filter((state) => state === "down").length} buckets with one or more rejected checks, ${stateWords.filter((state) => state === "none").length} buckets with no completed checks`}>
      {visible.length ? visible.map((bucket, index) => <i className={bucketState(bucket)} key={`${bucket.startAt}-${index}`} />) : <i className="none placeholder" />}
    </div>
  );
}

export function Notice({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "warning" | "error" }) {
  return <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}><span aria-hidden="true">{kind === "error" ? "!" : "i"}</span><div>{children}</div></div>;
}
