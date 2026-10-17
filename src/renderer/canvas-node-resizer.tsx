import { NodeResizer, useStore } from "@xyflow/react";
import { Maximize, RefreshCw } from "./icons.js";
import { t } from "./i18n.js";

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
        title={t("canvasNode.resetSize")}
        aria-label={t("canvasNode.resetSize")}
        onClick={runtime?.reset}
      >
        <RefreshCw size={14} />
      </button>
      {runtime?.open ? (
        <button
          type="button"
          title={t("canvasNode.expandText")}
          aria-label={t("canvasNode.expandText")}
          onClick={runtime.open}
        >
          <Maximize size={14} />
        </button>
      ) : null}
    </>
  );
}
