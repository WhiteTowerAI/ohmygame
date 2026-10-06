import { LoaderCircle } from "./icons.js";
import { createElement, useEffect, useRef, useState } from "react";

type ModelViewerElement = HTMLElement & { loaded?: boolean; availableAnimations?: string[] };

type ModelViewerError = CustomEvent<{
  type?: "loadfailure" | "webglcontextlost";
  sourceError?: unknown;
}>;

type ModelViewerProgress = CustomEvent<{
  totalProgress?: number;
}>;

export function ModelPreview({ source, label, minHeight = 320, interactive = true, clipPicker = true }: { source: string; label: string; minHeight?: number; interactive?: boolean; clipPicker?: boolean }) {
  const viewerRef = useRef<ModelViewerElement | null>(null);
  const [componentReady, setComponentReady] = useState(Boolean(customElements.get("model-viewer")));
  const [componentError, setComponentError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [modelError, setModelError] = useState<string>();
  const [clips, setClips] = useState<string[]>([]);
  const [clip, setClip] = useState<string>();

  useEffect(() => {
    if (componentReady) return;
    let active = true;
    void import("@google/model-viewer").then(() => {
      if (active) setComponentReady(true);
    }).catch(() => {
      if (active) setComponentError(true);
    });
    return () => { active = false; };
  }, [componentReady]);

  useEffect(() => {
    setLoaded(false);
    setProgress(0);
    setModelError(undefined);
    setClips([]);
    setClip(undefined);
  }, [source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!componentReady || !viewer) return;

    const handleLoad = () => {
      setProgress(1);
      setLoaded(true);
      // Rigged models carry one clip per move; model-viewer only autoplays the first unless one is named.
      setClips([...(viewer.availableAnimations ?? [])]);
    };
    const handleProgress = (event: Event) => {
      const nextProgress = (event as ModelViewerProgress).detail?.totalProgress;
      if (typeof nextProgress === "number") setProgress(nextProgress);
    };
    const handleError = (event: Event) => {
      const detail = (event as ModelViewerError).detail;
      console.error("3D preview failed", detail?.sourceError);
      const type = detail?.type;
      setModelError(type === "webglcontextlost"
        ? "The 3D preview lost its graphics context"
        : "Could not display this 3D model");
    };

    viewer.addEventListener("load", handleLoad);
    viewer.addEventListener("progress", handleProgress);
    viewer.addEventListener("error", handleError);
    if (viewer.loaded) handleLoad();

    return () => {
      viewer.removeEventListener("load", handleLoad);
      viewer.removeEventListener("progress", handleProgress);
      viewer.removeEventListener("error", handleError);
    };
  }, [componentReady, source]);

  if (!componentReady) {
    return <span className={`model-preview-standalone${componentError ? " model-preview-error" : ""}`} role={componentError ? "alert" : undefined}>
      {!componentError ? <LoaderCircle className="spin" size={16} /> : null}
      {componentError ? "Could not load the 3D viewer" : "Loading 3D viewer"}
    </span>;
  }

  return (
    <div className="model-preview" style={{ minHeight: `${minHeight}px` }}>
      {createElement("model-viewer", {
        key: source,
        ref: (element: ModelViewerElement | null) => { viewerRef.current = element; },
        src: source,
        alt: label,
        loading: "eager",
        "camera-controls": interactive || undefined,
        "auto-rotate": true,
        // Plays the first clip of animated models (e.g. rigged characters); static models are unaffected.
        autoplay: true,
        "animation-name": clip,
        "shadow-intensity": "1",
        tabIndex: interactive ? undefined : -1,
        "aria-hidden": interactive ? undefined : true,
      })}
      {!loaded && !modelError ? (
        <span className="model-preview-state">
          <LoaderCircle className="spin" size={16} />
          {progress > 0 ? `Loading 3D model ${Math.round(progress * 100)}%` : "Loading 3D model"}
        </span>
      ) : null}
      {modelError ? <span className="model-preview-state model-preview-error" role="alert">{modelError}</span> : null}
      {clipPicker && clips.length > 1 ? (
        // nodrag/nowheel keep canvas nodes from treating the picker as a drag or zoom.
        <select
          className="model-preview-clips nodrag nowheel"
          aria-label="Animation clip"
          value={clip ?? clips[0]}
          onChange={(event) => setClip(event.target.value)}
        >
          {clips.map((name) => <option key={name} value={name}>{name.replace(/_/g, " ")}</option>)}
        </select>
      ) : null}
    </div>
  );
}
