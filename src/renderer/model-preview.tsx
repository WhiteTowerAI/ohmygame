import { LoaderCircle, Pause, Play } from "./icons.js";
import { createElement, useEffect, useRef, useState } from "react";
import { t } from "./i18n.js";
import { IconButton } from "./ui/button.js";

type ModelViewerElement = HTMLElement & {
  loaded: boolean;
  availableAnimations: string[];
  modelIsVisible: boolean;
  autoRotate: boolean;
  paused: boolean;
  play: () => void;
  pause: () => void;
};

type ModelViewerError = CustomEvent<{
  type?: "loadfailure" | "webglcontextlost";
  sourceError?: unknown;
}>;

type ModelViewerProgress = CustomEvent<{
  totalProgress?: number;
}>;

export function ModelPreview({ source, label, minHeight = 320, interactive = true, controls = true }: { source: string; label: string; minHeight?: number; interactive?: boolean; controls?: boolean }) {
  const viewerRef = useRef<ModelViewerElement | null>(null);
  const [componentReady, setComponentReady] = useState(Boolean(customElements.get("model-viewer")));
  const [componentError, setComponentError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [modelError, setModelError] = useState<string>();
  const [clips, setClips] = useState<string[]>([]);
  const [clip, setClip] = useState<string>();
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (componentReady) return;
    let active = true;
    void import("@google/model-viewer").then(() => {
      if (active) setComponentReady(true);
    }).catch((error: unknown) => {
      console.error("3D viewer failed to load", error);
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
    setPlaying(false);
  }, [source]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!componentReady || !viewer) return;

    const handleLoad = () => {
      setProgress(1);
      setLoaded(true);
      // Rigged models carry one clip per move; let the person choose which to play.
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
        ? t("modelPreview.contextLost")
        : t("modelPreview.displayFailed"));
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

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!componentReady || !viewer) return;
    // Keep the current camera and frame. Autoplay=false alone does not pause
    // a model that was already playing, so use the viewer's playback API too.
    const syncPlayback = () => {
      const active = controls && playing && !modelError && viewer.modelIsVisible && document.visibilityState !== "hidden";
      viewer.autoRotate = Boolean(active);
      if (active && viewer.paused) viewer.play();
      else if (!active) viewer.pause();
    };
    viewer.addEventListener("load", syncPlayback);
    viewer.addEventListener("model-visibility", syncPlayback);
    document.addEventListener("visibilitychange", syncPlayback);
    syncPlayback();
    return () => {
      viewer.removeEventListener("load", syncPlayback);
      viewer.removeEventListener("model-visibility", syncPlayback);
      document.removeEventListener("visibilitychange", syncPlayback);
      viewer.autoRotate = false;
      viewer.pause();
    };
  }, [componentReady, source, controls, playing, modelError]);

  if (!componentReady) {
    return <span className={`model-preview-standalone${componentError ? " model-preview-error" : ""}`} role={componentError ? "alert" : undefined}>
      {!componentError ? <LoaderCircle className="spin" size={16} /> : null}
      {componentError ? t("modelPreview.viewerFailed") : t("modelPreview.loadingViewer")}
    </span>;
  }

  return (
    <div className="model-preview" style={{ minHeight: `${minHeight}px` }}>
      {createElement("model-viewer", {
        key: source,
        ref: (element: ModelViewerElement | null) => { viewerRef.current = element; },
        src: source,
        alt: label,
        loading: "lazy",
        "camera-controls": interactive || undefined,
        // The default interaction hint wiggles the camera forever, even paused.
        "interaction-prompt": "none",
        "animation-name": clip,
        "shadow-intensity": "1",
        tabIndex: interactive ? undefined : -1,
        "aria-hidden": interactive ? undefined : true,
      })}
      {!loaded && !modelError ? (
        <span className="model-preview-state">
          <LoaderCircle className="spin" size={16} />
          {progress > 0 ? t("modelPreview.loadingProgress", { percent: Math.round(progress * 100) }) : t("modelPreview.loading")}
        </span>
      ) : null}
      {modelError ? <span className="model-preview-state model-preview-error" role="alert">{modelError}</span> : null}
      {controls && loaded && !modelError ? (
        // nodrag/nowheel keep canvas nodes from treating the controls as a drag or zoom.
        <div className="model-preview-controls nodrag nowheel">
          <IconButton size="sm" label={t(playing ? "modelPreview.pause" : "modelPreview.play")} active={playing} onClick={() => setPlaying((value) => !value)}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </IconButton>
          {clips.length > 1 ? <select
            className="model-preview-clips"
            aria-label={t("modelPreview.clip")}
            value={clip ?? clips[0]}
            onChange={(event) => setClip(event.target.value)}
          >
            {clips.map((name) => <option key={name} value={name}>{name.replace(/_/g, " ")}</option>)}
          </select> : null}
        </div>
      ) : null}
    </div>
  );
}
