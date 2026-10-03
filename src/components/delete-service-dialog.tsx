"use client";

import { useEffect, useRef, useState } from "react";

import { MonitorApiError, removeService } from "@/lib/monitor-api";

interface DeleteServiceDialogProps {
  service: { id: string; name: string; url: string };
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteServiceDialog({ service, onClose, onDeleted }: DeleteServiceDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [deleting, onClose]);

  async function confirmDelete() {
    setDeleting(true);
    setError(null);
    try {
      await removeService(service.id);
      onDeleted();
    } catch (cause) {
      setError(cause instanceof MonitorApiError ? cause.message : "Unable to delete the service. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onClose(); }}>
      <section className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description">
        <div className="dialog-icon" aria-hidden="true">!</div>
        <h2 id="delete-title">Delete this service?</h2>
        <p id="delete-description">This permanently removes the service and every check in its history.</p>
        <div className="dialog-target"><strong>{service.name}</strong><br /><span className="service-url">{service.url}</span></div>
        <p className="dialog-warning">This cannot be undone. Monitoring data cannot be restored.</p>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button className="button" ref={cancelRef} type="button" onClick={onClose} disabled={deleting}>Cancel</button>
          <button className="button danger" type="button" onClick={confirmDelete} disabled={deleting}>{deleting ? "Deleting…" : "Delete service"}</button>
        </div>
      </section>
    </div>
  );
}
