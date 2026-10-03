"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { DeleteServiceDialog } from "@/components/delete-service-dialog";
import { AppHeader, Notice, StatusBadge } from "@/components/monitor-ui";
import { getHistory, getService, MonitorApiError } from "@/lib/monitor-api";
import { checkResult, formatAvailability, formatDuration, formatRelativeTime } from "@/lib/monitor-format";
import type { HistoryRange, ServiceHistory, ServiceSummary } from "@/lib/monitor-types";

const ranges: HistoryRange[] = ["24h", "7d", "30d", "90d"];

function HistoryChart({ history }: { history: ServiceHistory }) {
  const values = history.buckets.map((bucket) => bucket.averageResponseTimeMs).filter((value): value is number => value !== null);
  const highest = Math.max(...values, 1);
  return <div className="chart-wrap"><div className="chart" role="img" aria-label={`Response-time chart for ${history.range}. ${values.length ? `Highest hourly average ${Math.round(highest)} milliseconds.` : "No response-time data yet."}`}>{history.buckets.map((bucket, index) => <i className={bucket.averageResponseTimeMs === null ? "none" : ""} key={`${bucket.startAt}-${index}`} style={{ height: `${bucket.averageResponseTimeMs === null ? 6 : Math.max(8, (bucket.averageResponseTimeMs / highest) * 100)}%` }} />)}</div><p className="small muted">Response-time chart. Exact results remain available in the table below.</p></div>;
}

export function ServiceDetail({ id }: { id: string }) {
  const [service, setService] = useState<ServiceSummary | null>(null);
  const [history, setHistory] = useState<ServiceHistory | null>(null);
  const [range, setRange] = useState<HistoryRange>("24h");
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const load = useCallback(async () => { try { const [nextService, nextHistory] = await Promise.all([getService(id), getHistory(id, range)]); setService(nextService); setHistory(nextHistory); setError(null); } catch (cause) { setError(cause instanceof MonitorApiError ? cause.message : "Unable to load this service."); } }, [id, range]);
  useEffect(() => { void load(); }, [load]);
  async function more() { if (!history?.nextCursor) return; setMoreLoading(true); try { const page = await getHistory(id, range, history.nextCursor); setHistory((current) => current ? { ...page, checks: [...current.checks, ...page.checks] } : page); } finally { setMoreLoading(false); } }
  if (error && !service) return <><AppHeader /><main className="page" id="main-content"><section className="panel empty-state" role="alert"><h1>Service unavailable</h1><p>{error}</p><Link className="button" href="/">Back to dashboard</Link></section></main></>;
  if (!service || !history) return <><AppHeader /><main className="page loading" id="main-content" aria-label="Loading service"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></main></>;
  const latest = service.latestCheck;
  return <><AppHeader /><main className="page" id="main-content"><Link className="back-link" href="/">← Back to dashboard</Link><div className="title-row"><div><div className="eyebrow">Service</div><h1>{service.name}</h1><p className="service-url">{service.url}</p></div><div className="dashboard-actions"><StatusBadge status={service.status} /><button className="button danger" type="button" onClick={() => setDeleteOpen(true)}>Delete service</button></div></div>
    {service.status === "stale" ? <Notice kind="warning">The last observation is stale. The last known result is still shown below.</Notice> : null}{error ? <Notice kind="error">{error}</Notice> : null}
    <div className="detail-grid"><div className="detail-main"><section className="panel"><div className="panel-heading"><h2>Current result</h2><StatusBadge status={service.status} /></div><div className="metrics"><div className="metric"><span className="small muted">Latest result</span><strong>{checkResult(latest)}</strong></div><div className="metric"><span className="small muted">Response time</span><strong>{formatDuration(latest?.responseTimeMs ?? null)}</strong></div><div className="metric"><span className="small muted">Last completed</span><strong>{formatRelativeTime(latest?.completedAt ?? null)}</strong></div></div></section>
      <section className="panel"><div className="panel-heading"><div><h2>Response time</h2><p className="small muted">Hourly averages · {range}</p></div><div className="range-tabs" aria-label="History range">{ranges.map((item) => <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{item}</button>)}</div></div><HistoryChart history={history} /></section>
      <section className="panel"><div className="panel-heading"><div><h2>Exact checks</h2><p className="small muted">All times are UTC. Availability counts completed checks only.</p></div><strong>{formatAvailability(history.availability)}</strong></div>{history.checks.length === 0 ? <div className="empty-state"><h2>No completed checks in this range</h2><p>Monitoring results will appear here after the worker completes a check.</p></div> : <><table className="check-table"><thead><tr><th scope="col">Completed</th><th scope="col">Result</th><th scope="col">Response</th><th scope="col">Outcome</th></tr></thead><tbody>{history.checks.map((check) => <tr key={check.id || `${check.completedAt}-${check.outcome}`}><td>{new Date(check.completedAt).toLocaleString(undefined, { timeZone: "UTC" })}</td><td>{checkResult(check)}</td><td>{formatDuration(check.responseTimeMs)}</td><td><StatusBadge status={check.outcome} /></td></tr>)}</tbody></table>{history.nextCursor ? <div className="form-actions"><button className="button" type="button" onClick={() => void more()} disabled={moreLoading}>{moreLoading ? "Loading…" : "Load more checks"}</button></div> : null}</>}</section></div>
      <aside className="detail-side"><section className="panel"><div className="panel-heading"><h2>Configuration</h2></div><div className="form-card"><p><strong>Check interval</strong><br /><span className="muted">Every {service.intervalSeconds} seconds</span></p><p><strong>Accepted status</strong><br /><span className="muted">HTTP {service.acceptedStatusMin}–{service.acceptedStatusMax}</span></p><p><strong>History retention</strong><br /><span className="muted">90 days</span></p></div></section></aside></div>
  </main>{deleteOpen ? <DeleteServiceDialog service={service} onClose={() => setDeleteOpen(false)} onDeleted={() => { setDeleteOpen(false); window.location.assign("/"); }} /> : null}</>;
}
