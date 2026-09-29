import { useEffect, useRef, type RefObject } from "react";
import type { PromptContext, PromptImage, PromptReference } from "../shared/contracts.js";
import type { NodeGraph } from "../shared/playable-nodes.js";
import type { PlayablePickResult } from "../shared/playable-picker.js";
import {
  playableElementContext,
  playableSurfaceContext,
  playableSurfaceReferences,
  type PlayableChatSurface,
} from "../shared/playable-chat-context.js";
import type { ChatContextChip } from "./chat-reference.js";
import { captureElementImage } from "./page-capture.js";

/** Screenshots of picked elements stay small; they only show where the element is. */
const ELEMENT_SCREENSHOT_WIDTH = 960;

/**
 * What the Playable editor contributes to the next chat message: the Node or
 * Shell (the Scene or Overlay) open in its Workbench, and an element picked in that preview.
 */
export interface PlayableChatState {
  surface?: {
    /** Identifies the surface, so a removed chip comes back for another one. */
    key: string;
    chip: ChatContextChip;
    context: PromptContext;
    references: PromptReference[];
  };
  element?: {
    chip: ChatContextChip;
    context: PromptContext;
    /** A screenshot of the preview with the element marked. */
    capture: () => Promise<PromptImage | undefined>;
  };
  clearElement: () => void;
}

/**
 * Reports what an open Workbench adds to the next chat message, and nothing
 * once it closes. `stage` holds the preview whose frame is captured.
 */
export function usePlayableChatReport({ graph, surface, picked, clearPicked, stage, onChange }: {
  graph: NodeGraph;
  surface: PlayableChatSurface;
  picked?: PlayablePickResult;
  clearPicked: () => void;
  stage: RefObject<HTMLElement | null>;
  onChange?: (state: PlayableChatState | undefined) => void;
}): void {
  const clear = useRef(clearPicked);
  clear.current = clearPicked;
  const surfaceKey = surface.kind === "node" ? `node:${surface.nodeId}` : "shell";

  useEffect(() => {
    if (!onChange) return;
    const context = playableSurfaceContext(graph, surface);
    const elementContext = picked ? playableElementContext(picked) : undefined;
    onChange({
      ...(context ? {
        surface: {
          key: surfaceKey,
          chip: { kind: "playable-node", label: context.label, detail: surface.kind === "node" ? "Scene" : "Stays on screen" },
          context,
          references: playableSurfaceReferences(graph, surface),
        },
      } : {}),
      ...(picked && elementContext ? {
        element: {
          chip: { kind: "playable-element", label: elementContext.label, detail: picked.source ?? picked.cssPath },
          context: elementContext,
          capture: async () => {
            const frame = stage.current?.querySelector(".playable-player-frame");
            return frame ? capturePlayableElement(frame, graph.viewport, picked.box) : undefined;
          },
        },
      } : {}),
      clearElement: () => clear.current(),
    });
  }, [graph, surfaceKey, picked, onChange]);

  useEffect(() => () => onChange?.(undefined), [onChange]);
}

/**
 * Captures a preview frame and outlines a box given in project viewport
 * pixels. Returns undefined when the window cannot be captured.
 */
export async function capturePlayableElement(
  frame: Element,
  viewport: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
): Promise<PromptImage | undefined> {
  const image = await captureElementImage(frame, ELEMENT_SCREENSHOT_WIDTH, (context, width, height) => {
    const scaleX = width / viewport.width;
    const scaleY = height / viewport.height;
    const lineWidth = Math.max(2, Math.round(width / 320));
    context.strokeStyle = "#ff5a1f";
    context.lineWidth = lineWidth;
    context.strokeRect(
      box.x * scaleX - lineWidth / 2,
      box.y * scaleY - lineWidth / 2,
      box.width * scaleX + lineWidth,
      box.height * scaleY + lineWidth,
    );
  });
  if (!image) return undefined;
  return { name: "picked-element.webp", mediaType: "image/webp", data: await blobBase64(image) };
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
