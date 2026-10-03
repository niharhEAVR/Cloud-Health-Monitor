"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { createService, MonitorApiError } from "@/lib/monitor-api";
import { Notice } from "@/components/monitor-ui";

type Values = { name: string; url: string; intervalSeconds: string; acceptedStatusMin: string; acceptedStatusMax: string };
const initialValues: Values = { name: "", url: "", intervalSeconds: "60", acceptedStatusMin: "200", acceptedStatusMax: "299" };

export function CreateServiceForm() {
  const router = useRouter();
  const [values, setValues] = useState<Values>(initialValues);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [intervalMode, setIntervalMode] = useState<"preset" | "custom">("preset");
  const update = (key: keyof Values) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValues((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setFormError(null); setErrors({});
    try {
      const service = await createService({ name: values.name, url: values.url, intervalSeconds: Number(values.intervalSeconds), acceptedStatusMin: Number(values.acceptedStatusMin), acceptedStatusMax: Number(values.acceptedStatusMax) });
      router.push(`/services/${service.id}`);
    } catch (cause) {
      if (cause instanceof MonitorApiError) { setFormError(cause.message); setErrors(cause.fieldErrors ?? {}); }
      else setFormError("Unable to create the service. Please try again.");
      setSubmitting(false);
    }
  }
  const error = (key: string) => errors[key]?.[0];
  return <main className="form-page" id="main-content"><Link className="back-link" href="/">← Back to dashboard</Link><div className="form-title"><h1>Create service</h1><p className="muted">Choose an endpoint and define a healthy response.</p></div>
    {formError ? <Notice kind="error">{formError}</Notice> : null}
    <form className="panel" onSubmit={submit} noValidate aria-label="Create monitored service"><div className="form-card">
      <div className="field"><label htmlFor="service-name">Service name</label><input id="service-name" value={values.name} onChange={update("name")} autoComplete="off" aria-invalid={Boolean(error("name"))} aria-describedby="service-name-hint service-name-error" required maxLength={100} />{error("name") ? <p className="field-error" id="service-name-error">{error("name")}</p> : <p className="hint" id="service-name-hint">A recognizable name for your dashboard.</p>}</div>
      <div className="field"><label htmlFor="endpoint-url">Endpoint URL</label><input id="endpoint-url" value={values.url} onChange={update("url")} type="url" inputMode="url" placeholder="https://status.example.com/health" aria-invalid={Boolean(error("url"))} aria-describedby="endpoint-url-hint endpoint-url-error" required />{error("url") ? <p className="field-error" id="endpoint-url-error">{error("url")}</p> : <p className="hint" id="endpoint-url-hint">A publicly reachable HTTP or HTTPS endpoint. Private and local network addresses are blocked.</p>}</div>
      <hr className="form-divider" /><div className="field"><label htmlFor="check-interval">Check interval</label><select id="check-interval" value={intervalMode === "custom" ? "custom" : values.intervalSeconds} onChange={(event) => { if (event.target.value === "custom") setIntervalMode("custom"); else { setIntervalMode("preset"); setValues((current) => ({ ...current, intervalSeconds: event.target.value })); } }} aria-invalid={Boolean(error("intervalSeconds"))}><option value="30">Every 30 seconds</option><option value="60">Every 60 seconds</option><option value="300">Every 5 minutes</option><option value="900">Every 15 minutes</option><option value="3600">Every hour</option><option value="86400">Every 24 hours</option><option value="custom">Custom interval…</option></select>{intervalMode === "custom" ? <><label className="visually-hidden" htmlFor="custom-check-interval">Custom check interval in seconds</label><input id="custom-check-interval" type="number" min="30" max="86400" value={values.intervalSeconds} onChange={update("intervalSeconds")} aria-invalid={Boolean(error("intervalSeconds"))} aria-describedby="interval-hint" style={{ marginTop: 10 }} required /></> : null}<p className="hint" id="interval-hint">Choose how often this service is checked. Use a custom whole-second interval from 30 seconds to 24 hours.</p></div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="fieldset-legend">Accepted HTTP status range</legend><div className="status-range"><div className="field"><label htmlFor="status-min">Minimum</label><input id="status-min" type="number" min="100" max="599" value={values.acceptedStatusMin} onChange={update("acceptedStatusMin")} aria-invalid={Boolean(error("acceptedStatusMin"))} required /></div><span className="range-separator" aria-hidden="true">–</span><div className="field"><label htmlFor="status-max">Maximum</label><input id="status-max" type="number" min="100" max="599" value={values.acceptedStatusMax} onChange={update("acceptedStatusMax")} aria-invalid={Boolean(error("acceptedStatusMax"))} required /></div></div>{error("acceptedStatusMin") || error("acceptedStatusMax") ? <p className="field-error">{error("acceptedStatusMin") ?? error("acceptedStatusMax")}</p> : <p className="hint">Inclusive range. Other HTTP responses and connection errors count as down.</p>}</fieldset>
      <Notice>Monitoring starts after creation. The service appears as waiting until its first result. Check history is retained for 90 days.</Notice>
    </div><div className="form-actions"><Link className="button" href="/">Cancel</Link><button className="button primary" type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create service"}</button></div></form>
  </main>;
}
