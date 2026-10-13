import { useEffect, useRef, useState } from "react";
import { playableThumbnailHash } from "../shared/playable-editor.js";
import type { NodePlayerDefinition, PlayablePreviewOptions } from "../shared/playable-player-protocol.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import { getNodeRuntime, playableSandboxUrl, setPlayableThumbnail } from "./api.js";
import { captureElementImage } from "./page-capture.js";
import { createMemoryStorage, NodePlayer } from "./playable-player.js";
import { loadPlayableAssets } from "./playable-assets.js";

/** How long a Node runs before its thumbnail is taken, so entrances settle. */
const NODE_THUMBNAIL_DELAY_MS = 1_000;
/** Sharp on a high-density card, and small enough to cache for every Node. */
const NODE_THUMBNAIL_WIDTH = 1_280;

/**
 * The page of the hidden window that takes a Node's thumbnail for the canvas:
 * it runs the Node as the Workbench preview does, captures it once it has run
 * for a moment without errors, stores the image, and reports back.
 */
export function NodeThumbnailPage({
  projectId,
  nodeId,
}: {
  projectId: string;
  nodeId: string;
}) {
  const [playable, setPlayable] = useState<{
    definition: NodePlayerDefinition;
    assets: Record<string, Blob>;
    hash: string;
  }>();
  const [runningHash, setRunningHash] = useState<string>();
  const [storage] = useState(createMemoryStorage);
  const stage = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  function finish(captured: boolean): void {
    if (done.current) return;
    done.current = true;
    window.clearTimeout(timer.current);
    void window.ohMyGameDesktop?.finishNodeThumbnail?.(captured);
  }

  useEffect(() => {
    void getNodeRuntime(projectId).then(async (result) => {
      const hash = result.available ? playableThumbnailHash(result.definition, nodeId) : undefined;
      if (!result.available || !hash) return finish(false);
      const assets = await loadPlayableAssets(projectId, result.definition.graph);
      setPlayable({ definition: result.definition, assets, hash });
    }).catch(() => finish(false));
  }, [projectId, nodeId]);

  useEffect(() => {
    if (!runningHash) return;
    let cancelled = false;
    timer.current = window.setTimeout(() => {
      void waitForPaint()
        .then(async () => {
          if (cancelled || done.current) return;
          const frame = stage.current?.querySelector(".playable-player-frame");
          const status = stage.current?.querySelector(
            ".playable-player-status",
          );
          if (!frame || status) return finish(false);
          const image = await captureElementImage(frame, NODE_THUMBNAIL_WIDTH);
          if (cancelled || done.current || !image) return finish(false);
          await setPlayableThumbnail(projectId, nodeId, runningHash, image);
          finish(true);
        })
        .catch(() => finish(false));
    }, NODE_THUMBNAIL_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [projectId, nodeId, runningHash]);

  function onSnapshot(snapshot: NodeRuntimeSnapshot): void {
    if (done.current || !playable) return;
    if (snapshot.errors.length || snapshot.status === "failed")
      return finish(false);
    if (snapshot.status !== "running" || snapshot.currentNodeId !== nodeId)
      return;
    setRunningHash(playable.hash);
  }

  const preview: PlayablePreviewOptions = { policy: "report", startNodeId: nodeId };
  return <div ref={stage} className="playable-thumbnail-page">
    {playable ? <NodePlayer
      definition={playable.definition}
      frameUrl={playableSandboxUrl()}
      assets={playable.assets}
      saveKey={`ohmygame:playable:thumbnail:${projectId}`}
      storage={storage}
      preview={preview}
      onSnapshot={onSnapshot}
      onDiagnostic={ignoreDiagnostic}
    /> : null}
  </div>;
}

/** Diagnostics are the Workbench's to show; the capture only needs a clean run. */
function ignoreDiagnostic(): void {}

/** Lets React remove its loading cover and Chromium present the ready frame. */
function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}
