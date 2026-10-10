import { NodeResizer, useStore } from "@xyflow/react";
import { Maximize, RefreshCw } from "./icons.js";

export const CANVAS_READABLE_SIZES = {
  text: { width: 300, height: 190 },
  document: { width: 360, height: 330 },
  table: { width: 640, height: 360 },
};
export interface CanvasNodeResizeRuntime {
  start(): void;
  end(): void;
  reset(): void;
  open?: () => void;
}

export function CanvasNodeResizer({
  selected,
  runtime,
}: {
  selected?: boolean;
  runtime?: CanvasNodeResizeRuntime;
}) {
  const pointerMode = useStore((state) => state.nodesDraggable);
  return (
    <NodeResizer
      isVisible={Boolean(selected && pointerMode)}
      minWidth={240}
      minHeight={160}
      maxWidth={4096}
      maxHeight={4096}
      color="var(--theme-accent)"
      handleClassName="canvas-node-resize-handle"
      lineClassName="canvas-node-resize-line"
      onResizeStart={runtime?.start}
      onResizeEnd={runtime?.end}
    />
  );
}

export function CanvasNodeSizeActions({
  runtime,
}: {
  runtime?: CanvasNodeResizeRuntime;
}) {
  return (
    <>
      <button
        type="button"
        title="Reset node size"
        aria-label="Reset node size"
        onClick={runtime?.reset}
      >
        <RefreshCw size={14} />
      </button>
      {runtime?.open ? (
        <button
          type="button"
          title="Expand text"
          aria-label="Expand text"
          onClick={runtime.open}
        >
          <Maximize size={14} />
        </button>
      ) : null}
    </>
  );
}
