import { Box, Spinner, Pause, Play, TriangleAlert } from "./icons.js";
import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "./i18n.js";
import { Button } from "./ui/button.js";
import { useSeenOnScreen } from "./use-seen-on-screen.js";

export interface ModelFrame {
  readonly isConnected: boolean;
  readonly modelIsVisible: boolean;
  toBlob(options: { mimeType: string }): Promise<Blob>;
}
export interface ThumbnailCapture {
  settled(): void;
  failed(): void;
  capture(frame: ModelFrame): void;
}

type ModelViewerElement = HTMLElement & ModelFrame & {
  loaded: boolean;
  availableAnimations: string[];
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

/**
 * A model parses and reaches the GPU on the main thread, so a board or chat of
 * them loading at once stalls the window. Viewers on screen take turns.
 */
const MODEL_LOADS_AT_ONCE = 2;
let modelLoads = 0;
const waitingModels: Array<() => void> = [];

/** Calls `start` when this model may load; the returned function ends its turn, or leaves the queue. */
export function takeModelLoadTurn(start: () => void, priority = false): () => void {
  let state: "waiting" | "loading" | "done" = "waiting";
  const begin = () => { state = "loading"; modelLoads++; start(); };
  if (modelLoads < MODEL_LOADS_AT_ONCE) begin();
  else if (priority) waitingModels.unshift(begin);
  else waitingModels.push(begin);
  return () => {
    if (state === "waiting") waitingModels.splice(waitingModels.indexOf(begin), 1);
    else if (state === "loading") { modelLoads--; waitingModels.shift()?.(); }
    state = "done";
  };
}

/** The same quiet placeholder while a tile waits for bytes, the viewer, or its first frame. */
export function ModelPlaceholder({ error }: { error?: string }) {
  return error
    ? <span className="model-placeholder" role="img" aria-label={error} title={error}><TriangleAlert size="lg" aria-hidden="true" /></span>
    : <Box className="model-placeholder" size="lg" aria-hidden="true" />;
}

/** `autoPlay` starts a model's clip as it loads: for a view of one model, not a board or chat of them. */
export function ModelPreview({ source, label, minHeight = 320, interactive = true, controls = true, autoPlay = false, thumbnail }: { source: string; label: string; minHeight?: number; interactive?: boolean; controls?: boolean; autoPlay?: boolean; thumbnail?: ThumbnailCapture }) {
  const viewerRef = useRef<ModelViewerElement | null>(null);
  const [componentReady, setComponentReady] = useState(Boolean(customElements.get("model-viewer")));
  const [componentError, setComponentError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [modelError, setModelError] = useState<string>();
  const [clips, setClips] = useState<string[]>([]);
  const [clip, setClip] = useState<string>();
  const [playing, setPlaying] = useState(autoPlay);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const compact = !interactive && !controls;
  const seen = useSeenOnScreen(thumbnail ? null : frame);
  // The source whose turn it is: a new source must wait for its own.
  const [turnSource, setTurnSource] = useState<string>();
  const turn = Boolean(thumbnail) || turnSource === source;
  const endTurn = useRef(() => {});

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
    setPlaying(autoPlay);
  }, [source, autoPlay]);

  useEffect(() => {
    if (componentError) thumbnail?.failed();
  }, [componentError, thumbnail]);

  useEffect(() => {
    if (!seen || thumbnail) return;
    const end = takeModelLoadTurn(() => setTurnSource(source), autoPlay);
    endTurn.current = end;
    return () => { end(); setTurnSource(undefined); };
  }, [seen, source, thumbnail, autoPlay]);

  // Listen as the viewer is put in the page, before it can fail: a missed
  // error would keep its turn from every other model.
  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    if (!componentReady || !viewer) return;

    const captureVisible = () => {
      if (viewer.loaded && viewer.modelIsVisible && document.visibilityState !== "hidden") thumbnail?.capture(viewer);
    };
    const handleLoad = () => {
      endTurn.current();
      thumbnail?.settled();
      captureVisible();
      setProgress(1);
      setLoaded(true);
      // Rigged models carry one clip per move; let the person choose which to play.
      if (controls) setClips([...(viewer.availableAnimations ?? [])]);
    };
    const handleProgress = (event: Event) => {
      const nextProgress = (event as ModelViewerProgress).detail?.totalProgress;
      if (typeof nextProgress === "number") setProgress(nextProgress);
    };
    const handleError = (event: Event) => {
      endTurn.current();
      thumbnail?.failed();
      const detail = (event as ModelViewerError).detail;
      console.error("3D preview failed", detail?.sourceError);
      const type = detail?.type;
      setModelError(type === "webglcontextlost"
        ? t("modelPreview.contextLost")
        : t("modelPreview.displayFailed"));
    };

    if (thumbnail) {
      viewer.addEventListener("model-visibility", captureVisible);
      document.addEventListener("visibilitychange", captureVisible);
    }
    viewer.addEventListener("load", handleLoad);
    if (!compact) viewer.addEventListener("progress", handleProgress);
    viewer.addEventListener("error", handleError);
    if (viewer.loaded) handleLoad();

    return () => {
      viewer.removeEventListener("model-visibility", captureVisible);
      document.removeEventListener("visibilitychange", captureVisible);
      viewer.removeEventListener("load", handleLoad);
      viewer.removeEventListener("progress", handleProgress);
      viewer.removeEventListener("error", handleError);
    };
  }, [componentReady, source, turn, thumbnail, compact, controls]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!componentReady || !viewer) return;
    // Keep the current camera and frame. Autoplay=false alone does not pause
    // a model that was already playing, so use the viewer's playback API too.
    // Playing never turns the model: the person drags it to see another side.
    if (!controls) { viewer.pause(); return; }
    const syncPlayback = () => {
      const active = playing && !modelError && viewer.modelIsVisible && document.visibilityState !== "hidden";
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
      viewer.pause();
    };
  }, [componentReady, source, controls, playing, modelError, turn]);

  if (!componentReady) {
    if (compact) return <ModelPlaceholder error={componentError ? t("modelPreview.viewerFailed") : undefined} />;
    return <span className={`model-preview-standalone${componentError ? " model-preview-error" : ""}`} role={componentError ? "alert" : undefined}>
      {!componentError ? <Spinner size="md" /> : null}
      {componentError ? t("modelPreview.viewerFailed") : t("modelPreview.loadingViewer")}
    </span>;
  }

  return (
    <div ref={setFrame} className="model-preview" style={{ minHeight: `${minHeight}px` }}>
      {turn ? createElement("model-viewer", {
        key: source,
        ref: (element: ModelViewerElement | null) => { viewerRef.current = element; },
        src: source,
        alt: label,
        // Its turn already waited for the screen.
        loading: "eager",
        "camera-controls": interactive || undefined,
        // The default interaction hint wiggles the camera forever, even paused.
        "interaction-prompt": "none",
        "animation-name": clip,
        "shadow-intensity": "1",
        tabIndex: interactive ? undefined : -1,
        "aria-hidden": interactive ? undefined : true,
      }) : null}
      {compact && (!loaded || modelError) ? <span className="model-preview-state"><ModelPlaceholder error={modelError} /></span> : null}
      {!compact && !loaded && !modelError ? (
        <span className="model-preview-state">
          <Spinner size="md" />
          {progress > 0 ? t("modelPreview.loadingProgress", { percent: Math.round(progress * 100) }) : t("modelPreview.loading")}
        </span>
      ) : null}
      {!compact && modelError ? <span className="model-preview-state model-preview-error" role="alert">{modelError}</span> : null}
      {controls && loaded && !modelError && clips.length > 0 ? (
        // A model with nothing to play is a still: it gets no controls.
        // nodrag/nowheel keep canvas nodes from treating the controls as a drag or zoom.
        <div className="model-preview-controls nodrag nowheel">
          <Button size="sm" icon={playing ? <Pause size="sm" fill="currentColor" /> : <Play size="sm" fill="currentColor" />} aria-label={t(playing ? "modelPreview.pause" : "modelPreview.play")} title={t(playing ? "modelPreview.pause" : "modelPreview.play")} aria-pressed={playing || undefined} onClick={() => setPlaying((value) => !value)}>
            {t(playing ? "modelPreview.pauseAction" : "modelPreview.playAction")}
          </Button>
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
