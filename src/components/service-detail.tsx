"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { DeleteServiceDialog } from "@/components/delete-service-dialog";
import { AppHeader, Notice, StatusBadge } from "@/components/monitor-ui";
import type { WorkerState } from "@/components/monitor-ui";
import { getDashboard, getHistory, getService, MonitorApiError } from "@/lib/monitor-api";
import { checkResult, formatAvailability, formatDuration, formatRelativeTime } from "@/lib/monitor-format";
import type { HistoryRange, ServiceHistory, ServiceSummary } from "@/lib/monitor-types";

const ranges: HistoryRange[] = ["24h", "7d", "30d", "90d"];

function checkKey(check: ServiceHistory["checks"][number]): string {
  return check.id || `${check.completedAt}-${check.outcome}-${check.httpStatus ?? "transport"}`;
}

function mergeChecks(current: ServiceHistory["checks"], incoming: ServiceHistory["checks"]): ServiceHistory["checks"] {
  const checks = new Map<string, ServiceHistory["checks"][number]>();
  for (const check of [...incoming, ...current]) checks.set(checkKey(check), check);
  return [...checks.values()].sort((left, right) => new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime());
}

function HistoryChart({ history }: { history: ServiceHistory }) {
  const values = history.buckets.map((bucket) => bucket.averageResponseTimeMs).filter((value): value is number => value !== null);
  const highest = Math.max(...values, 1);
  const bucketLabel = history.range === "24h" ? "hourly" : "time-bucketed";
  const describedValues = history.buckets.map((bucket) => `${new Date(bucket.startAt).toLocaleString(undefined, { timeZone: "UTC" })}: ${formatDuration(bucket.averageResponseTimeMs)}`).join("; ");
  return <div className="chart-wrap"><div className="chart" role="img" aria-label={`${bucketLabel} average response time for ${history.range}. ${values.length ? `Highest ${bucketLabel} average ${Math.round(highest)} milliseconds.` : "No response-time data yet."}`} aria-describedby="response-time-data">{history.buckets.map((bucket, index) => <i className={bucket.averageResponseTimeMs === null ? "none" : ""} key={`${bucket.startAt}-${index}`} style={{ height: `${bucket.averageResponseTimeMs === null ? 6 : Math.max(8, (bucket.averageResponseTimeMs / highest) * 100)}%` }} />)}</div><p className="small muted">{bucketLabel[0]!.toUpperCase()}{bucketLabel.slice(1)} average response times. Exact results are available in the table below.</p><p className="visually-hidden" id="response-time-data">{describedValues || "No time buckets contain response-time data."}</p></div>;
}

export function ServiceDetail({ id }: { id: string }) {
  const [service, setService] = useState<ServiceSummary | null>(null);
  const [history, setHistory] = useState<ServiceHistory | null>(null);
  const [range, setRange] = useState<HistoryRange>("24h");
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [workerState, setWorkerState] = useState<WorkerState | undefined>();
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (initial = false) => {
    try {
      const [nextService, nextHistory, dashboard] = await Promise.all([getService(id), getHistory(id, range), getDashboard().catch(() => null)]);
      setService(nextService);
      setHistory((current) => current?.range === nextHistory.range ? { ...nextHistory, checks: mergeChecks(current.checks, nextHistory.checks) } : nextHistory);
      setWorkerState(dashboard === null ? undefined : dashboard.workerLastHeartbeatAt === null ? "unknown" : dashboard.workerDelayed ? "delayed" : "online");
      setError(null); setNotFound(false);
    } catch (cause) {
      const apiError = cause instanceof MonitorApiError ? cause : null;
      if (apiError?.status === 404) { setNotFound(true); setError(null); return; }
      setError(apiError?.message ?? "Unable to load this service.");
      if (initial) { setService(null); setHistory(null); }
    }
  }, [id, range]);

  useEffect(() => { void load(true); }, [load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && navigator.onLine) void load(); };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh); window.addEventListener("online", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh); };
  }, [load]);

  async function more() {
    if (!history?.nextCursor) return;
    setMoreLoading(true); setMoreError(null);
    try {
      const page = await getHistory(id, range, history.nextCursor);
      setHistory((current) => current?.range === page.range ? { ...page, checks: mergeChecks(current.checks, page.checks) } : page);
    } catch (cause) {
      setMoreError(cause instanceof MonitorApiError ? cause.message : "Unable to load more checks. Please try again.");
    } finally { setMoreLoading(false); }
  }

  if (notFound) return <><AppHeader workerState={workerState} /><main className="page" id="main-content"><section className="panel empty-state"><h1>Service not found</h1><p>This service may have been deleted. Return to the dashboard to see the monitored services that remain.</p><Link className="button primary" href="/">Back to dashboard</Link></section></main></>;
  if (error && !service) return <><AppHeader /><main className="page" id="main-content"><section className="panel empty-state" role="alert"><h1>Service unavailable</h1><p>{error}</p><button className="button primary" type="button" onClick={() => void load(true)}>Try again</button><Link className="button" href="/">Back to dashboard</Link></section></main></>;
  if (!service || !history) return <><AppHeader /><main className="page loading" id="main-content" aria-label="Loading service"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></main></>;

  const latest = service.latestCheck;
  return <><AppHeader workerState={workerState} /><main className="page" id="main-content"><Link className="back-link" href="/">← Back to dashboard</Link><div className="title-row"><div><div className="eyebrow">Service</div><h1>{service.name}</h1><p className="service-url">{service.url}</p></div><div className="dashboard-actions"><StatusBadge status={service.status} /><button className="button danger" ref={deleteTriggerRef} type="button" onClick={() => setDeleteOpen(true)}>Delete service</button></div></div>
    {service.status === "stale" ? <Notice kind="warning">The last observation is stale. The last known result is still shown below.</Notice> : null}{error ? <Notice kind="error">Refresh failed: {error} Showing the last successful result.</Notice> : null}
    <div className="detail-grid"><div className="detail-main"><section className="panel"><div className="panel-heading"><h2>Current result</h2><StatusBadge status={service.status} /></div><div className="metrics"><div className="metric"><span className="small muted">Latest result</span><strong>{checkResult(latest)}</strong></div><div className="metric"><span className="small muted">Response time</span><strong>{formatDuration(latest?.responseTimeMs ?? null)}</strong></div><div className="metric"><span className="small muted">Last completed</span><strong>{formatRelativeTime(latest?.completedAt ?? null)}</strong></div></div></section>
      <section className="panel"><div className="panel-heading"><div><h2>Response time</h2><p className="small muted">{range === "24h" ? "Hourly" : "Time-bucketed"} averages · {range}</p></div><div className="range-tabs" aria-label="History range">{ranges.map((item) => <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>)}</div></div><HistoryChart history={history} /></section>
      <section className="panel"><div className="panel-heading"><div><h2>Exact checks</h2><p className="small muted">All times are UTC. Availability counts completed checks only.</p></div><strong aria-label={`Availability for ${range}: ${formatAvailability(history.availability)}`}>{formatAvailability(history.availability)}</strong></div>{history.checks.length === 0 ? <div className="empty-state"><h2>No completed checks in this range</h2><p>Monitoring results will appear here after the worker completes a check.</p></div> : <><table className="check-table"><caption className="visually-hidden">Exact completed checks for the selected {range} range</caption><thead><tr><th scope="col">Completed</th><th scope="col">Result</th><th scope="col">Response</th><th scope="col">Outcome</th></tr></thead><tbody>{history.checks.map((check) => <tr key={check.id || `${check.completedAt}-${check.outcome}`}><td>{new Date(check.completedAt).toLocaleString(undefined, { timeZone: "UTC" })}</td><td>{checkResult(check)}</td><td>{formatDuration(check.responseTimeMs)}</td><td><StatusBadge status={check.outcome} /></td></tr>)}</tbody></table>{moreError ? <Notice kind="error">{moreError}</Notice> : null}{history.nextCursor ? <div className="form-actions"><button className="button" type="button" onClick={() => void more()} disabled={moreLoading}>{moreLoading ? "Loading…" : "Load more checks"}</button></div> : null}</>}</section></div>
      <aside className="detail-side"><section className="panel"><div className="panel-heading"><h2>Configuration</h2></div><div className="form-card"><p><strong>Check interval</strong><br /><span className="muted">Every {service.intervalSeconds} seconds</span></p><p><strong>Accepted status</strong><br /><span className="muted">HTTP {service.acceptedStatusMin}–{service.acceptedStatusMax}</span></p><p><strong>History retention</strong><br /><span className="muted">90 days</span></p></div></section></aside></div>
  </main>{deleteOpen ? <DeleteServiceDialog service={service} triggerRef={deleteTriggerRef} onClose={() => setDeleteOpen(false)} onDeleted={() => { setDeleteOpen(false); window.location.assign("/"); }} /> : null}</>;
}
