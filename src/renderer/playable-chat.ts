import { useEffect, useRef, type RefObject } from "react";
import type { PromptContext, PromptImage, PromptReference } from "../shared/contracts.js";
import type { NodeGraph } from "../shared/playable-nodes.js";
import type { PlayablePickResult } from "../shared/playable-picker.js";
import { playableDrawingContext, playableElementContext, playableNodeContext, playableNodeReferences } from "../shared/playable-chat-context.js";
import type { ChatContextChip } from "./chat-reference.js";
import { captureElementImage } from "./page-capture.js";

/** Screenshots sent with picks stay small; they only show where things are. */
const ELEMENT_SCREENSHOT_WIDTH = 960;
const MARK_COLOR = "#ff5a1f";
const DRAWING_KEY = "drawing";

/** One freehand stroke, in project viewport pixels. */
export type PlayableStroke = readonly { x: number; y: number }[];

/** Something the next chat message carries besides the open Node. */
export interface PlayableChatAttachment {
  chip: ChatContextChip;
  context: PromptContext;
}

/**
 * What the Playable editor contributes to the next chat message: the Node
 * (Scene) open in its Workbench, and the elements picked or drawn on in that
 * preview. Picks and the drawing share one screenshot.
 */
export interface PlayableChatState {
  surface?: {
    /** Identifies the Node, so a removed chip comes back for another one. */
    key: string;
    chip: ChatContextChip;
    context: PromptContext;
    references: PromptReference[];
  };
  attachments: PlayableChatAttachment[];
  /** A screenshot of the preview with the picks outlined and the drawing on it. */
  capture: () => Promise<PromptImage | undefined>;
  removeAttachment: (key: string) => void;
  clearAttachments: () => void;
}

/** Picks are told apart by where they came from. */
export function playablePickKey(pick: PlayablePickResult): string {
  return `pick:${pick.nodeId}:${pick.source ?? ""}:${pick.cssPath}`;
}

/**
 * Reports what an open Workbench adds to the next chat message, and nothing
 * once it closes. `stage` holds the preview whose frame is captured.
 */
export function usePlayableChatReport({ graph, nodeId, picks, strokes, onRemovePick, onClearPicks, onClearDrawing, stage, onChange }: {
  graph: NodeGraph;
  nodeId: string;
  picks: readonly PlayablePickResult[];
  strokes: readonly PlayableStroke[];
  onRemovePick: (key: string) => void;
  onClearPicks: () => void;
  onClearDrawing: () => void;
  stage: RefObject<HTMLElement | null>;
  onChange?: (state: PlayableChatState | undefined) => void;
}): void {
  const handlers = useRef({ onRemovePick, onClearPicks, onClearDrawing });
  handlers.current = { onRemovePick, onClearPicks, onClearDrawing };

  useEffect(() => {
    if (!onChange) return;
    const context = playableNodeContext(graph, nodeId);
    const attachments: PlayableChatAttachment[] = picks.map((pick) => {
      const elementContext = playableElementContext(pick);
      return {
        chip: { key: playablePickKey(pick), kind: "playable-element", label: elementContext.label, detail: pick.source ?? pick.cssPath },
        context: elementContext,
      };
    });
    if (strokes.length) {
      const drawing = playableDrawingContext(nodeId, strokes.length);
      attachments.push({ chip: { key: DRAWING_KEY, kind: "playable-drawing", label: drawing.label }, context: drawing });
    }
    onChange({
      ...(context ? {
        surface: {
          key: `node:${nodeId}`,
          chip: { key: `node:${nodeId}`, kind: "playable-node", label: context.label, detail: "Scene" },
          context,
          references: playableNodeReferences(graph, nodeId),
        },
      } : {}),
      attachments,
      capture: async () => {
        if (!picks.length && !strokes.length) return undefined;
        const frame = stage.current?.querySelector(".playable-player-frame");
        return frame ? capturePlayablePreview(frame, graph.viewport, picks.map((pick) => pick.box), strokes) : undefined;
      },
      removeAttachment: (key) => {
        if (key === DRAWING_KEY) handlers.current.onClearDrawing();
        else handlers.current.onRemovePick(key);
      },
      clearAttachments: () => {
        handlers.current.onClearPicks();
        handlers.current.onClearDrawing();
      },
    });
  }, [graph, nodeId, picks, strokes, onChange]);

  useEffect(() => () => onChange?.(undefined), [onChange]);
}

/**
 * Captures a preview frame, outlines boxes and draws strokes given in project
 * viewport pixels. Returns undefined when the window cannot be captured.
 */
export async function capturePlayablePreview(
  frame: Element,
  viewport: { width: number; height: number },
  boxes: readonly { x: number; y: number; width: number; height: number }[],
  strokes: readonly PlayableStroke[] = [],
): Promise<PromptImage | undefined> {
  // The capture reads window pixels, so the tool bar and drawing layer over
  // the preview are hidden while it runs; the strokes are drawn on it instead.
  const preview = frame.closest(".story-workbench-preview-frame");
  preview?.classList.add("is-capturing");
  await nextPaint();
  const image = await captureElementImage(frame, ELEMENT_SCREENSHOT_WIDTH, (context, width, height) => {
    const scaleX = width / viewport.width;
    const scaleY = height / viewport.height;
    const lineWidth = Math.max(2, Math.round(width / 320));
    context.strokeStyle = MARK_COLOR;
    context.lineWidth = lineWidth;
    for (const box of boxes) {
      context.strokeRect(
        box.x * scaleX - lineWidth / 2,
        box.y * scaleY - lineWidth / 2,
        box.width * scaleX + lineWidth,
        box.height * scaleY + lineWidth,
      );
    }
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = lineWidth * 1.5;
    for (const stroke of strokes) {
      context.beginPath();
      stroke.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x * scaleX, point.y * scaleY);
        else context.lineTo(point.x * scaleX, point.y * scaleY);
      });
      if (stroke.length === 1) context.lineTo(stroke[0]!.x * scaleX + 0.1, stroke[0]!.y * scaleY);
      context.stroke();
    }
  }).finally(() => preview?.classList.remove("is-capturing"));
  if (!image) return undefined;
  return { name: strokes.length ? "preview-drawing.webp" : "picked-element.webp", mediaType: "image/webp", data: await blobBase64(image) };
}

/** Waits for a paint, or a short while when the window is hidden and does not paint. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timeout);
      resolve();
    }));
  });
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
