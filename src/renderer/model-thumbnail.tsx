import { useEffect, useState } from "react";
import {
  getModelThumbnail,
  modelThumbnailQuery,
  saveModelThumbnail,
} from "./api.js";
import { acquireModelFile } from "./model-file.js";
import {
  ModelPreview,
  ModelPlaceholder,
  takeModelLoadTurn,
  type ModelFrame,
  type ThumbnailCapture,
} from "./model-preview.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { useWorkspaceAssetSource } from "./use-workspace-asset-url.js";

type Snapshot = {
  image?: string;
  model?: string;
  error?: string;
  capture?: ThumbnailCapture;
};
type Listener = (snapshot: Snapshot) => void;
const jobs = new Map<string, ThumbnailJob>();

/** Subscribers share one capture. If its tile leaves, the next visible tile hosts the viewer. */
class ThumbnailJob {
  listeners = new Map<Listener, boolean>();
  state: Snapshot = {};
  request = new AbortController();
  file?: ReturnType<typeof acquireModelFile>;
  endTurn?: () => void;
  version?: string;
  capturing?: ModelFrame;
  liveFallback = false;

  constructor(readonly query: string) {}

  publish() {
    const host =
      [...this.listeners].find(([, visible]) => visible)?.[0] ??
      this.listeners.keys().next().value;
    for (const listener of this.listeners.keys()) {
      if (!this.state.model) listener(this.state);
      else if (listener === host) listener({ ...this.state, capture: this });
      else listener(this.liveFallback ? this.state : {});
    }
  }

  async start(
    project: string | undefined,
    path: string,
    asset: string | undefined,
    revision: number,
  ) {
    try {
      const result = await getModelThumbnail(this.query, this.request.signal);
      this.version = result.version;
      if (result.image) {
        await this.showImage(result.image);
        return;
      }
    } catch (error) {
      if (!this.request.signal.aborted)
        console.warn("Model thumbnail lookup failed", error);
    }
    if (this.request.signal.aborted) return;
    this.endTurn = takeModelLoadTurn(() => {
      this.file = acquireModelFile(project, path, asset, revision);
      void this.file.result.then(
        (model) => {
          this.state = { model };
          this.publish();
        },
        (error: Error) => {
          this.settled();
          this.file?.release();
          this.file = undefined;
          this.state = { error: error.message };
          this.publish();
        },
      );
    });
  }

  settled = () => {
    this.endTurn?.();
  };

  failed = () => {
    this.settled();
    if (this.liveFallback) return;
    this.liveFallback = true;
    this.publish();
  };

  capture = (frame: ModelFrame) => {
    if (
      this.state.image ||
      this.capturing === frame ||
      this.request.signal.aborted
    )
      return;
    this.capturing = frame;
    void (async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt) await new Promise((resolve) => setTimeout(resolve, 64));
          if (this.request.signal.aborted || this.capturing !== frame) return;
          if (
            !frame.isConnected ||
            !frame.modelIsVisible ||
            document.visibilityState === "hidden"
          ) {
            this.capturing = undefined;
            return;
          }
          const blob = await frame.toBlob({ mimeType: "image/png" });
          if (this.request.signal.aborted || this.capturing !== frame) return;
          if (!(await this.showImage(blob, frame))) continue;
          this.capturing = undefined;
          if (this.version)
            await saveModelThumbnail(this.query, this.version, blob);
          return;
        }
        this.failed();
      } catch (error) {
        if (!this.request.signal.aborted) {
          this.failed();
          console.warn("Could not cache model thumbnail", error);
        }
      }
    })();
  };

  async showImage(blob: Blob, frame?: ModelFrame) {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      this.request.signal.throwIfAborted();
      if (frame && (frame !== this.capturing || !hasVisiblePixels(image))) {
        URL.revokeObjectURL(url);
        return false;
      }
      this.state = { image: url };
      this.publish();
      this.file?.release();
      this.file = undefined;
      return true;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  dispose() {
    this.request.abort();
    this.settled();
    this.file?.release();
    this.file = undefined;
    if (this.state.image) URL.revokeObjectURL(this.state.image);
  }
}

/** A viewer that just scrolled away can export a valid, entirely transparent PNG. */
function hasVisiblePixels(image: HTMLImageElement): boolean {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not inspect the model thumbnail");
  ctx.drawImage(image, 0, 0, 64, 64);
  const pixels = ctx.getImageData(0, 0, 64, 64).data;
  for (let alpha = 3; alpha < pixels.length; alpha += 4) {
    if (pixels[alpha]) return true;
  }
  return false;
}

type Props = {
  project?: string;
  path: string;
  asset?: string;
  revision?: number;
  label: string;
  large?: boolean;
};

export function ModelThumbnail(props: Props) {
  const { projectId, filePath, libraryAssetId, local } =
    useWorkspaceAssetSource(props.project, props.path, props.asset);
  const runtime = useReadyRuntimeGeneration();
  const revision = local?.revision ?? props.revision ?? 0;
  const query = modelThumbnailQuery(
    projectId,
    filePath,
    libraryAssetId,
    !!props.large,
  );
  const id = JSON.stringify([query, revision, runtime]);
  const [host, setHost] = useState<HTMLSpanElement | null>(null);
  const [result, setResult] = useState<{ id: string; view: Snapshot }>();
  const state = result?.id === id ? result.view : {};
  useEffect(() => {
    if (!host) return;
    const update: Listener = (view) => setResult({ id, view });
    let job: ThumbnailJob | undefined;
    let active = true;
    function observe(onScreen: boolean) {
      if (!active || (!job && !onScreen)) return;
      const existing = jobs.get(id);
      job = existing ?? new ThumbnailJob(query);
      jobs.set(id, job);
      job.listeners.set(update, onScreen);
      job.publish();
      if (!existing)
        void job.start(projectId, filePath, libraryAssetId, revision);
    }
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(([entry]) =>
            observe(!!entry?.isIntersecting),
          );
    if (observer) observer.observe(host);
    else observe(true);
    return () => {
      active = false;
      observer?.disconnect();
      if (!job) return;
      job.listeners.delete(update);
      if (job.listeners.size) job.publish();
      else {
        jobs.delete(id);
        job.dispose();
      }
    };
  }, [id, host, query, projectId, filePath, libraryAssetId, revision]);
  return (
    <span ref={setHost} className="model-thumbnail">
      {state.image ? (
        <img src={state.image} alt="" draggable={false} />
      ) : state.model ? (
        <ModelPreview
          source={state.model}
          label={props.label}
          interactive={false}
          controls={false}
          minHeight={0}
          thumbnail={state.capture}
        />
      ) : (
        <ModelPlaceholder error={state.error} />
      )}
    </span>
  );
}
