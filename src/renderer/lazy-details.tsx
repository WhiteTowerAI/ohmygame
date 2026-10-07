import { useState, type ReactNode } from "react";

export function LazyDetails({ className, summary, children }: { className: string; summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className={className} onToggle={(event) => setOpen(event.currentTarget.open)}>
    {summary}
    {open ? children : null}
  </details>;
}
