"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { MonitorApiError, removeService } from "@/lib/monitor-api";

interface DeleteServiceDialogProps {
  service: { id: string; name: string; url: string };
  onClose: () => void;
  onDeleted: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
}

export function DeleteServiceDialog({ service, onClose, onDeleted, triggerRef }: DeleteServiceDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const deletingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onDeletedRef = useRef(onDeleted);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  onCloseRef.current = onClose;
  onDeletedRef.current = onDeleted;

  useEffect(() => {
    returnFocusRef.current = triggerRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    cancelRef.current?.focus();
    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!deletingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keepFocusInDialog);
    return () => {
      document.removeEventListener("keydown", keepFocusInDialog);
      const focusTarget = triggerRef?.current ?? returnFocusRef.current;
      focusTarget?.focus();
    };
  }, []);

  async function confirmDelete() {
    setDeleting(true);
    deletingRef.current = true;
    setError(null);
    try {
      await removeService(service.id);
      onDeletedRef.current();
    } catch (cause) {
      setError(cause instanceof MonitorApiError ? cause.message : "Unable to delete the service. Please try again.");
      setDeleting(false);
      deletingRef.current = false;
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onCloseRef.current(); }}>
      <section className="dialog" ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description">
        <div className="dialog-icon" aria-hidden="true">!</div>
        <h2 id="delete-title">Delete this service?</h2>
        <p id="delete-description">This permanently removes the service and every check in its history.</p>
        <div className="dialog-target"><strong>{service.name}</strong><br /><span className="service-url">{service.url}</span></div>
        <p className="dialog-warning">This cannot be undone. Monitoring data cannot be restored.</p>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button className="button" ref={cancelRef} type="button" onClick={() => onCloseRef.current()} disabled={deleting}>Cancel</button>
          <button className="button danger" type="button" onClick={confirmDelete} disabled={deleting}>{deleting ? "Deleting…" : "Delete service"}</button>
        </div>
      </section>
    </div>
  );
}
