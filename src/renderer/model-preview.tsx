import { LoaderCircle } from "lucide-react";
import { createElement, useEffect, useState } from "react";

export function ModelPreview({ source, label, minHeight = 320 }: { source: string; label: string; minHeight?: number }) {
  const [ready, setReady] = useState(Boolean(customElements.get("model-viewer")));
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (ready) return;
    let active = true;
    void import("@google/model-viewer").then(() => {
      if (active) setReady(true);
    }).catch(() => {
      if (active) setError("Could not load 3D preview");
    });
    return () => { active = false; };
  }, [ready]);
  if (error) return <span className="tool-dialog-error">{error}</span>;
  if (!ready) return <span className="tool-project-state"><LoaderCircle className="spin" size={16} />Loading 3D preview</span>;
  return createElement("model-viewer", {
    src: source,
    alt: label,
    "camera-controls": true,
    "auto-rotate": true,
    "shadow-intensity": "1",
    style: { width: "100%", height: "100%", minHeight: `${minHeight}px` },
  });
}
