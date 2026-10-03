"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getDashboard, MonitorApiError } from "@/lib/monitor-api";
import { checkResult, formatAvailability, formatDuration, formatRelativeTime } from "@/lib/monitor-format";
import type { DashboardData, DisplayStatus, ServiceSummary } from "@/lib/monitor-types";
import { AppHeader, HistoryStrip, Notice, StatusBadge } from "@/components/monitor-ui";
import { DeleteServiceDialog } from "@/components/delete-service-dialog";

const FILTERS: Array<{ value: "all" | DisplayStatus; label: string }> = [
  { value: "all", label: "All statuses" }, { value: "up", label: "Operational" }, { value: "down", label: "Down" },
  { value: "pending", label: "Waiting" }, { value: "stale", label: "Stale" },
];

function overallStatus(data: DashboardData): { label: string; tone: "up" | "down" | "pending" | "stale"; message: string } {
  if (data.counts.down > 0) return { label: "Needs attention", tone: "down", message: `${data.counts.down} service${data.counts.down === 1 ? " is" : "s are"} currently down.` };
  if (data.counts.stale > 0) return { label: "Observations are stale", tone: "stale", message: "Some services have not reported a recent result." };
  if (data.services.length === 0 || data.counts.pending > 0) return { label: "Waiting for checks", tone: "pending", message: "New services are shown as waiting until their first check finishes." };
  return { label: "All services operational", tone: "up", message: "Every current check is within its accepted status range." };
}

function averageAvailability(services: ServiceSummary[]): number | null {
  let accepted = 0; let completed = 0;
  for (const service of services) for (const bucket of service.history) { accepted += bucket.acceptedChecks; completed += bucket.completedChecks; }
  return completed === 0 ? null : accepted / completed;
}

function ServiceCard({ service, onDelete }: { service: ServiceSummary; onDelete: (service: ServiceSummary) => void }) {
  const latest = service.latestCheck;
  return <article className="service-card">
    <div className="card-top"><div><Link className="service-name" href={`/services/${service.id}`}>{service.name}</Link><div className="service-url">{service.url}</div></div><StatusBadge status={service.status} /></div>
    <div className="card-metrics"><div><span>Latest</span><strong>{checkResult(latest)}</strong></div><div><span>Last checked</span><strong>{formatRelativeTime(latest?.completedAt ?? null)}</strong></div><div><span>Response</span><strong>{formatDuration(latest?.responseTimeMs ?? null)}</strong></div><div><span>Every {service.intervalSeconds}s</span><strong>{formatAvailability(service.availability24h)} 24h</strong></div></div>
    <div className="card-history"><HistoryStrip buckets={service.history} label={`${service.name} last 24 hours`} /><span>{formatAvailability(service.availability24h)}</span><button className="button icon" type="button" aria-label={`Delete ${service.name}`} onClick={() => onDelete(service)}>×</button></div>
  </article>;
}

function ServiceRows({ services, onDelete }: { services: ServiceSummary[]; onDelete: (service: ServiceSummary) => void }) {
  return <>
    <table className="service-table"><thead><tr><th scope="col" style={{ width: "26%" }}>Service</th><th scope="col">Current status</th><th scope="col">Latest result</th><th scope="col">Last checked</th><th scope="col">24h availability</th><th scope="col" style={{ width: "18%" }}>Last 24 hours</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
      <tbody>{services.map((service) => { const latest = service.latestCheck; return <tr key={service.id}><td><Link className="service-name" href={`/services/${service.id}`}>{service.name}</Link><div className="service-url">{service.url}</div></td><td><StatusBadge status={service.status} /></td><td><strong>{checkResult(latest)}</strong><div className="small muted">{formatDuration(latest?.responseTimeMs ?? null)}</div></td><td>{formatRelativeTime(latest?.completedAt ?? null)}<div className="small muted">Every {service.intervalSeconds}s</div></td><td><strong>{formatAvailability(service.availability24h)}</strong></td><td><HistoryStrip buckets={service.history} label={`${service.name} last 24 hours`} /></td><td><button className="button icon" type="button" aria-label={`Delete ${service.name}`} onClick={() => onDelete(service)}>×</button></td></tr>; })}</tbody>
    </table>
    <div className="service-cards">{services.map((service) => <ServiceCard key={service.id} service={service} onDelete={onDelete} />)}</div>
  </>;
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | DisplayStatus>("all");
  const [deleting, setDeleting] = useState<ServiceSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (initial = false) => {
    if (!initial) setRefreshing(true);
    try { const next = await getDashboard(); setData(next); setError(null); setBackgroundError(null); }
    catch (cause) { const message = cause instanceof MonitorApiError ? cause.message : "Unable to load service health."; if (initial) setError(message); else setBackgroundError(message); }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => { void load(true); }, [load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && navigator.onLine) void load(); };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh); window.addEventListener("online", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh); };
  }, [load]);

  const shown = useMemo(() => (data?.services ?? []).filter((service) => (filter === "all" || service.status === filter) && `${service.name} ${service.url}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name)), [data, filter, query]);
  const state = data ? overallStatus(data) : null;
  const availability = data ? averageAvailability(data.services) : null;

  if (error && !data) return <><AppHeader /><main className="page" id="main-content"><section className="panel empty-state" role="alert"><h1>Dashboard unavailable</h1><p>{error}</p><button className="button primary" onClick={() => void load(true)}>Try again</button></section></main></>;
  if (!data || !state) return <><AppHeader /><main className="page loading" id="main-content" aria-label="Loading dashboard"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></main></>;

  return <><AppHeader workerDelayed={data.workerDelayed} /><main className="page" id="main-content">
    <div className="title-row"><div><div className="eyebrow">Overview</div><h1>Service health</h1></div><div className="dashboard-actions"><span className="muted small">{refreshing ? "Refreshing…" : "Auto-refreshes every 15s"}</span><button className="button" onClick={() => void load()} disabled={refreshing}>Refresh</button><Link className="button primary" href="/services/new">+ Create service</Link></div></div>
    {data.workerDelayed ? <Notice kind="warning">The check worker has not reported recently. Existing service results are preserved, but new observations may be delayed.</Notice> : null}
    {backgroundError ? <Notice kind="error">Refresh failed: {backgroundError} Showing the last successful snapshot.</Notice> : null}
    <section className="summary-grid" aria-label="Fleet health summary"><div className="summary-card"><div className="summary-label">Current health</div><div className="health-line"><i className={`health-dot ${state.tone}`} />{state.label}</div><div className="small muted">{state.message}</div></div><div className="summary-card"><div className="summary-label">Monitored services</div><div className="summary-value">{data.services.length}</div><div className="small muted">Public HTTP(S) endpoints only</div></div><div className="summary-card"><div className="summary-label">Current status</div><div className="summary-value">{data.counts.up} <span className="small muted">up</span> · {data.counts.down} <span className="small muted">down</span></div><div className="small muted">{data.counts.pending} waiting · {data.counts.stale} stale</div></div><div className="summary-card"><div className="summary-label">Availability · last 24 hours</div><div className="summary-value">{formatAvailability(availability)}</div><div className="small muted">Successful completed checks</div></div></section>
    <section className="panel" aria-labelledby="services-heading"><div className="panel-heading"><div><h2 id="services-heading">Monitored services <span className="count">{shown.length}</span></h2></div><div className="search-filter"><input aria-label="Search services" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search services" /><select aria-label="Filter by status" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>{FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div></div>
      {data.services.length === 0 ? <div className="empty-state"><div className="empty-icon" aria-hidden="true"><i /><i /><i /></div><h2>Add your first service</h2><p>Monitor a public endpoint for response time, expected HTTP status, and check-based availability.</p><Link className="button primary" href="/services/new">+ Create service</Link><p className="small">Anyone with access can add or delete services. Deploy behind a trusted network boundary.</p></div> : shown.length === 0 ? <div className="empty-state"><h2>No matching services</h2><p>Try a different search or status filter.</p><button className="button" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></div> : <><ServiceRows services={shown} onDelete={setDeleting} /><div className="table-footer"><span>Green: all checks passed · Red: one or more checks failed · Gray: no checks</span><span>24 hourly buckets · oldest to newest</span></div></>}</section>
  </main>{deleting ? <DeleteServiceDialog service={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); void load(); }} /> : null}</>;
}
