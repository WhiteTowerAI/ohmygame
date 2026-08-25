import { ChevronDown, Download, Hand, Maximize, Minus, MousePointer2, Play, Plus } from "lucide-react";
import { useState } from "react";
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  useReactFlow,
  useViewport,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const EMPTY_NODES: Node[] = [];
const EMPTY_EDGES: Edge[] = [];
type InteractionMode = "pointer" | "pan";

export function InteractiveDramaWorkspace() {
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("pointer");

  return (
    <section className="viewer-pane interactive-drama-workspace" aria-label="Interactive Drama workspace">
      <header className="interactive-drama-header">
        <button className="interactive-drama-chapter" type="button">
          <span>Chapter 1 / Untitled</span>
          <ChevronDown size={14} />
        </button>
        <div className="interactive-drama-header-actions">
          <button className="interactive-drama-action" type="button" title="Playtest">
            <Play size={14} fill="currentColor" />
            <span>Playtest</span>
          </button>
          <button className="interactive-drama-action interactive-drama-action-primary" type="button" title="Build game">
            <Download size={14} />
            <span>Build game</span>
          </button>
        </div>
      </header>
      <div className="interactive-drama-canvas">
        <ReactFlow
          className={`story-canvas story-canvas-${interactionMode}`}
          nodes={EMPTY_NODES}
          edges={EMPTY_EDGES}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          nodesDraggable={interactionMode === "pointer"}
          elementsSelectable={interactionMode === "pointer"}
          selectionOnDrag={interactionMode === "pointer"}
          panOnDrag={interactionMode === "pan" ? true : [1, 2]}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--interactive-drama-grid)" />
          <ZoomControls />
          <CanvasToolbar mode={interactionMode} onModeChange={setInteractionMode} />
        </ReactFlow>
      </div>
    </section>
  );
}

function CanvasToolbar({ mode, onModeChange }: { mode: InteractionMode; onModeChange: (mode: InteractionMode) => void }) {
  const { fitView, getNodes, setViewport } = useReactFlow();

  async function fitCanvas(): Promise<void> {
    if (getNodes().length === 0) {
      await setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 });
      return;
    }
    await fitView({ padding: 0.2, duration: 200 });
  }

  return (
    <Panel className="story-canvas-toolbar" position="bottom-center">
      <button type="button" title="Add node" aria-label="Add node" disabled>
        <Plus size={18} />
      </button>
      <button
        className={mode === "pointer" ? "is-active" : undefined}
        type="button"
        title="Select"
        aria-label="Select"
        aria-pressed={mode === "pointer"}
        onClick={() => onModeChange("pointer")}
      >
        <MousePointer2 size={18} />
      </button>
      <button
        className={mode === "pan" ? "is-active" : undefined}
        type="button"
        title="Pan canvas"
        aria-label="Pan canvas"
        aria-pressed={mode === "pan"}
        onClick={() => onModeChange("pan")}
      >
        <Hand size={18} />
      </button>
      <button type="button" title="Fit view" aria-label="Fit view" onClick={() => void fitCanvas()}>
        <Maximize size={18} />
      </button>
    </Panel>
  );
}

function ZoomControls() {
  const { zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { zoom } = useViewport();

  return (
    <Panel className="story-canvas-zoom" position="bottom-left">
      <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => void zoomOut()}>
        <Minus size={14} />
      </button>
      <button className="story-canvas-zoom-value" type="button" title="Reset zoom" onClick={() => void zoomTo(1)}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => void zoomIn()}>
        <Plus size={14} />
      </button>
    </Panel>
  );
}
