import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
  ReactFlow,
  ViewportPortal,
  useReactFlow,
  useStore,
  useViewport,
  type Edge,
  type Node,
  type ReactFlowInstance,
  type ReactFlowProps,
} from "@xyflow/react";
import {
  CANVAS_GRID_SIZE,
  findCanvasAlignmentGuides,
  snapCanvasPosition,
  type CanvasAlignmentGuides,
  type CanvasAlignmentNode,
} from "./canvas-alignment.js";
import { Hand, Maximize, Minus, MousePointer2, Plus } from "./icons.js";

type CanvasPosition = { x: number; y: number };
type InteractionMode = "pointer" | "pan";

export interface CanvasContextMenuState {
  kind: "pane" | "node";
  nodeId?: string;
  screenPosition: CanvasPosition;
  flowPosition: CanvasPosition;
}

const EDGE_COLOR = "var(--story-edge-color)";
const EDGE_OPTIONS = {
  style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: EDGE_COLOR },
};
// The edge options set the stroke inline, which React Flow's `.selected` CSS cannot override, so selection restyles the edge itself.
const SELECTED_EDGE_COLOR = "var(--theme-accent)";
const SELECTED_EDGE_OPTIONS = {
  style: { stroke: SELECTED_EDGE_COLOR, strokeWidth: 2 },
  markerEnd: { ...EDGE_OPTIONS.markerEnd, color: SELECTED_EDGE_COLOR },
};
const SNAP_GRID: [number, number] = [CANVAS_GRID_SIZE, CANVAS_GRID_SIZE];

type EditorCanvasProps<N extends Node> = Omit<ReactFlowProps<N, Edge>, "onPaneContextMenu" | "onNodeDrag"> & {
  nodes: N[];
  /** The Add control at the start of the tool bar. */
  addControl: ReactNode;
  onOpenMenu: (menu: CanvasContextMenuState) => void;
};

/**
 * The canvas both editors share: pan and zoom, pointer and pan modes, grid
 * snapping, alignment guides while dragging, the zoom controls, and the tool
 * bar. Nodes, edges, and what they mean belong to each editor.
 */
export function EditorCanvas<N extends Node>({
  nodes,
  edges,
  addControl,
  onOpenMenu,
  onInit,
  onNodeDragStart,
  onNodeDragStop,
  onNodeContextMenu,
  children,
  ...props
}: EditorCanvasProps<N>) {
  const [mode, setMode] = useState<InteractionMode>("pointer");
  const [guides, setGuides] = useState<CanvasAlignmentGuides>();
  const instance = useRef<ReactFlowInstance<N, Edge>>(null);

  function openMenu(event: { preventDefault: () => void; clientX: number; clientY: number }, kind: CanvasContextMenuState["kind"], nodeId?: string): void {
    event.preventDefault();
    const flowPosition = instance.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (!flowPosition) return;
    onOpenMenu({
      kind,
      nodeId,
      screenPosition: { x: event.clientX, y: event.clientY },
      flowPosition: snapCanvasPosition(flowPosition),
    });
  }

  return (
    <ReactFlow<N, Edge>
      className={`story-canvas story-canvas-${mode}`}
      nodes={nodes}
      edges={edges?.map((edge) => edge.selected ? { ...edge, ...SELECTED_EDGE_OPTIONS } : edge)}
      defaultEdgeOptions={EDGE_OPTIONS}
      connectionLineStyle={EDGE_OPTIONS.style}
      minZoom={0.25}
      maxZoom={2}
      snapToGrid
      snapGrid={SNAP_GRID}
      nodesDraggable={mode === "pointer"}
      elementsSelectable={mode === "pointer"}
      selectionOnDrag={mode === "pointer"}
      panOnDrag={mode === "pan" ? true : [1, 2]}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
      {...props}
      onInit={(value) => { instance.current = value; onInit?.(value); }}
      onNodeDragStart={(event, node, dragged) => { setGuides(undefined); onNodeDragStart?.(event, node, dragged); }}
      onNodeDrag={(_event, node) => {
        const [active, ...candidates] = alignmentNodesFromDom([node, ...nodes]);
        setGuides(active ? findCanvasAlignmentGuides(active, candidates) : undefined);
      }}
      onNodeDragStop={(event, node, dragged) => { setGuides(undefined); onNodeDragStop?.(event, node, dragged); }}
      onPaneContextMenu={(event) => openMenu(event, "pane")}
      onNodeContextMenu={(event, node) => { onNodeContextMenu?.(event, node); openMenu(event, "node", node.id); }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--interactive-story-grid)" />
      <AlignmentGuides guides={guides} />
      <ZoomControls />
      <Panel className="story-canvas-toolbar" position="bottom-center">
        {addControl}
        <button className={mode === "pointer" ? "is-active" : undefined} type="button" title="Select" aria-label="Select" aria-pressed={mode === "pointer"} onClick={() => setMode("pointer")}>
          <MousePointer2 size={18} />
        </button>
        <button className={mode === "pan" ? "is-active" : undefined} type="button" title="Pan canvas" aria-label="Pan canvas" aria-pressed={mode === "pan"} onClick={() => setMode("pan")}>
          <Hand size={18} />
        </button>
        <FitViewButton />
      </Panel>
      {children}
    </ReactFlow>
  );
}

/** Where the tool bar adds a node: the center of the visible canvas. */
export function useCanvasCenter(): () => CanvasPosition | undefined {
  const { screenToFlowPosition } = useReactFlow();
  const domNode = useStore((state) => state.domNode);
  return () => {
    const bounds = domNode?.getBoundingClientRect();
    if (!bounds) return undefined;
    return screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
  };
}
/**
 * A context menu at the pointer, kept inside the window. It closes on a
 * click outside, Escape, or a window resize; the items are the editor's.
 */
export function CanvasContextMenu({ screenPosition, label, onClose, children }: {
  screenPosition: CanvasPosition;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(screenPosition);
  const opensLeft = screenPosition.x > window.innerWidth - 600;
  const opensUp = screenPosition.y > window.innerHeight / 2;

  useLayoutEffect(() => {
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({
      x: Math.max(6, Math.min(screenPosition.x, window.innerWidth - bounds.width - 6)),
      y: Math.max(6, Math.min(screenPosition.y, window.innerHeight - bounds.height - 6)),
    });
    root.current?.focus();
  }, [screenPosition.x, screenPosition.y]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as globalThis.Node)) onClose();
    };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={root}
      className={`story-canvas-context-menu${opensLeft ? " opens-left" : ""}${opensUp ? " opens-up" : ""}`}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Which history step a key press asks for, if any. */
export function undoShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): "undo" | "redo" | undefined {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return undefined;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.metaKey) return "redo";
  return undefined;
}

/** A field that handles its own typing, so canvas shortcuts leave it alone. */
export function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type !== "checkbox" && target.type !== "radio"));
}

function FitViewButton() {
  const { fitView, getNodes, setViewport } = useReactFlow();
  async function fitCanvas(): Promise<void> {
    if (getNodes().length === 0) {
      await setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 200 });
      return;
    }
    await fitView({ padding: 0.2, duration: 200 });
  }
  return <button type="button" title="Fit view" aria-label="Fit view" onClick={() => void fitCanvas()}><Maximize size={18} /></button>;
}

function AlignmentGuides({ guides }: { guides?: CanvasAlignmentGuides }) {
  const { zoom } = useViewport();
  if (!guides) return null;
  const lineWidth = 1 / zoom;
  return <ViewportPortal>
    {guides.vertical.map((guide) => <div
      key={`vertical:${guide.x}`}
      className="story-canvas-alignment-guide is-vertical"
      data-axis="vertical"
      style={{ left: guide.x - lineWidth / 2, top: guide.from, width: lineWidth, height: guide.to - guide.from }}
    />)}
    {guides.horizontal.map((guide) => <div
      key={`horizontal:${guide.y}`}
      className="story-canvas-alignment-guide is-horizontal"
      data-axis="horizontal"
      style={{ left: guide.from, top: guide.y - lineWidth / 2, width: guide.to - guide.from, height: lineWidth }}
    />)}
  </ViewportPortal>;
}

function alignmentNodesFromDom<T extends { id: string; position: CanvasPosition }>(nodes: readonly T[]): CanvasAlignmentNode[] {
  const zoom = canvasViewportZoom();
  const roots = new Map([...document.querySelectorAll<HTMLElement>(".react-flow__node[data-id]")]
    .map((element) => [element.dataset.id!, element] as const));
  return nodes.map((node) => {
    const root = roots.get(node.id);
    const frame = root?.querySelector<HTMLElement>("[data-alignment-frame]");
    if (!root || !frame) return node;
    const rootRect = root.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    return {
      ...node,
      alignmentFrame: {
        x: node.position.x + (frameRect.left - rootRect.left) / zoom,
        y: node.position.y + (frameRect.top - rootRect.top) / zoom,
        width: frameRect.width / zoom,
        height: frameRect.height / zoom,
      },
    };
  });
}

function canvasViewportZoom(): number {
  const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
  const transform = viewport ? getComputedStyle(viewport).transform : "none";
  if (transform === "none") return 1;
  try {
    const zoom = new DOMMatrixReadOnly(transform).a;
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  } catch {
    return 1;
  }
}

function ZoomControls() {
  const { zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel className="story-canvas-zoom" position="bottom-left">
      <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => void zoomOut()}><Minus size={14} /></button>
      <button className="story-canvas-zoom-value" type="button" title="Reset zoom" onClick={() => void zoomTo(1)}>{Math.round(zoom * 100)}%</button>
      <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => void zoomIn()}><Plus size={14} /></button>
    </Panel>
  );
}
