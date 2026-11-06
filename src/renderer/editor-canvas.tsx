import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
  ReactFlow,
  ViewportPortal,
  useReactFlow,
  useNodesInitialized,
  useStore,
  useStoreApi,
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
// React Flow's own layout rules, loaded with the one canvas both editors use,
// since either editor may be the first to load.
import "@xyflow/react/dist/style.css";
import { t } from "./i18n.js";

type CanvasPosition = { x: number; y: number };
type AlignmentFrame = NonNullable<CanvasAlignmentNode["alignmentFrame"]>;
type InteractionMode = "pointer" | "pan";

export interface CanvasContextMenuState {
  kind: "pane" | "node" | "add";
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
  selectionAction?: ReactNode;
  onOpenMenu: (menu: CanvasContextMenuState) => void;
  /** Open the menu as "add" on a double-click on empty canvas in pointer mode. */
  addOnDoubleClick?: boolean;
  pickingReferences?: boolean;
  fitViewOnLoad?: boolean;
  onInitialFit?: (viewport: { x: number; y: number; zoom: number }) => void;
};

/**
 * The canvas both editors share: pan and zoom, pointer and pan modes, grid
 * snapping, alignment guides while dragging, the zoom controls, and the tool
 * bar. Nodes, edges, and what they mean belong to each editor.
 */
export function EditorCanvas<N extends Node>({
  nodes,
  edges,
  deleteKeyCode = "Backspace",
  addControl,
  selectionAction,
  onOpenMenu,
  addOnDoubleClick = false,
  onInit,
  onNodeDragStart,
  onNodeDragStop,
  onNodeContextMenu,
  onNodeClick,
  onNodeDoubleClick,
  fitViewOnLoad = false,
  pickingReferences = false,
  onInitialFit,
  style,
  children,
  ...props
}: EditorCanvasProps<N>) {
  const [mode, setMode] = useState<InteractionMode>("pointer");
  const [guides, setGuides] = useState<CanvasAlignmentGuides>();
  const instance = useRef<ReactFlowInstance<N, Edge>>(null);
  // React Flow applies defaultViewport in an effect. Keep measuring the canvas,
  // but do not paint its initial 100% view before the saved viewport (or fit).
  const [viewportReady, setViewportReady] = useState(false);
  const needsInitialFit = fitViewOnLoad && nodes.some((node) => !node.hidden);
  const wrapper = useRef<HTMLDivElement>(null);
  const dragFrames = useRef<Map<string, AlignmentFrame>>(null);
  const spacePanning = useSpacePan(wrapper);
  const panning = mode === "pan" || spacePanning;
  const selecting = !panning && !pickingReferences;

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
      ref={wrapper}
      className={`story-canvas story-canvas-${panning ? "pan" : "pointer"}`}
      nodes={nodes}
      edges={edges?.map((edge) => edge.selected ? { ...edge, ...SELECTED_EDGE_OPTIONS } : edge)}
      defaultEdgeOptions={EDGE_OPTIONS}
      connectionLineStyle={EDGE_OPTIONS.style}
      minZoom={0.1}
      maxZoom={2}
      snapToGrid
      snapGrid={SNAP_GRID}
      nodesDraggable={selecting}
      elementsSelectable={selecting}
      nodesConnectable={selecting}
      selectionOnDrag={selecting}
      selectionKeyCode={null}
      multiSelectionKeyCode={["Shift", "Meta", "Control"]}
      // Scope Space to this canvas and leave inputs and controls their own keys.
      panActivationKeyCode={null}
      panOnDrag={panning ? [0, 1] : [1]}
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
      {...props}
      deleteKeyCode={null}
      style={{ ...style, ...(!viewportReady ? { opacity: 0, pointerEvents: "none" as const } : {}) }}
      onInit={(value) => {
        instance.current = value;
        if (!needsInitialFit) setViewportReady(true);
        onInit?.(value);
      }}
      onNodeDragStart={(event, node, dragged) => {
        dragFrames.current = measureAlignmentFrames(wrapper.current);
        setGuides(undefined);
        onNodeDragStart?.(event, node, dragged);
      }}
      onNodeDrag={(_event, node) => {
        const frames = dragFrames.current ?? measureAlignmentFrames(wrapper.current);
        const activeFrame = frames.get(node.id);
        if (!activeFrame) return;
        const positioned = (candidate: N, frame: AlignmentFrame) => ({
          id: candidate.id, alignmentFrame: { ...frame, x: candidate.position.x + frame.x, y: candidate.position.y + frame.y },
        });
        const candidates = nodes.flatMap((candidate) => {
          const frame = frames.get(candidate.id);
          return frame && !candidate.dragging ? [positioned(candidate, frame)] : [];
        });
        setGuides(findCanvasAlignmentGuides(positioned(node, activeFrame), candidates));
      }}
      onNodeDragStop={(event, node, dragged) => {
        dragFrames.current = null;
        setGuides(undefined);
        onNodeDragStop?.(event, node, dragged);
      }}
      // Keep a click handler in pan mode so React Flow still lets node controls receive pointer events.
      onNodeClick={(event, node) => { if (!panning) onNodeClick?.(event, node); }}
      onNodeDoubleClick={(event, node) => { if (!panning) onNodeDoubleClick?.(event, node); }}
      onPaneContextMenu={(event) => openMenu(event, "pane")}
      onDoubleClick={(event) => {
        if (addOnDoubleClick && !panning && (event.target as Element).classList.contains("react-flow__pane")) openMenu(event, "add");
      }}
      onNodeContextMenu={(event, node) => { onNodeContextMenu?.(event, node); openMenu(event, "node", node.id); }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--interactive-story-grid)" />
      <AlignmentGuides guides={guides} />
      <ZoomControls />
      <PinchZoomOverScrollingContent />
      {needsInitialFit ? <InitialCanvasView onReady={onInitialFit} onVisible={setViewportReady} /> : null}
      <Panel className="story-canvas-toolbar" position="bottom-center">
        {addControl}
        {selectionAction}
        <button className={mode === "pointer" ? "is-active" : undefined} type="button" data-tooltip={t("editorCanvas.selectHint")} aria-label={t("editorCanvas.select")} aria-pressed={mode === "pointer"} onClick={() => setMode("pointer")}>
          <MousePointer2 size={18} />
        </button>
        <button className={mode === "pan" ? "is-active" : undefined} type="button" data-tooltip={t("editorCanvas.pan")} aria-label={t("editorCanvas.pan")} aria-pressed={mode === "pan"} onClick={() => setMode("pan")}>
          <Hand size={18} />
        </button>
        <FitViewButton />
      </Panel>
      <DeleteKeys keys={deleteKeyCode} canvas={wrapper} />
      {children}
    </ReactFlow>
  );
}

/**
 * React Flow leaves every wheel event over `nowheel` content to that content,
 * including a trackpad pinch, which macOS sends as a wheel event with ctrlKey.
 * Content scrolls but never zooms, so a pinch there zooms the canvas the way
 * React Flow zooms it everywhere else.
 */
function PinchZoomOverScrollingContent() {
  const domNode = useStore((state) => state.domNode);
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    if (!domNode) return;
    const pinch = (event: WheelEvent) => {
      if (!event.ctrlKey || !(event.target instanceof Element) || !event.target.closest(".nowheel")) return;
      event.preventDefault();
      const bounds = domNode.getBoundingClientRect();
      void setViewport(pinchedViewport(
        getViewport(),
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        event,
        { minZoom, maxZoom, mac: navigator.platform.startsWith("Mac") },
      ));
    };
    domNode.addEventListener("wheel", pinch, { passive: false });
    return () => domNode.removeEventListener("wheel", pinch);
  }, [domNode, minZoom, maxZoom, getViewport, setViewport]);
  return null;
}

/** The viewport after a pinch at `pointer`, which keeps the point under it in place; React Flow's own pinch step. */
export function pinchedViewport(
  viewport: { x: number; y: number; zoom: number },
  pointer: CanvasPosition,
  wheel: Pick<WheelEvent, "deltaY" | "deltaMode">,
  { minZoom, maxZoom, mac }: { minZoom: number; maxZoom: number; mac: boolean },
): { x: number; y: number; zoom: number } {
  const delta = -wheel.deltaY * (wheel.deltaMode === 1 ? 0.05 : wheel.deltaMode ? 1 : 0.002) * (mac ? 10 : 1);
  const zoom = Math.min(maxZoom, Math.max(minZoom, viewport.zoom * 2 ** delta));
  const scale = zoom / viewport.zoom;
  return {
    x: pointer.x - (pointer.x - viewport.x) * scale,
    y: pointer.y - (pointer.y - viewport.y) * scale,
    zoom,
  };
}

/** Wait for actual node sizes and a visible canvas before consuming a remix's fit request. */
function InitialCanvasView({ onReady, onVisible }: {
  onReady?: (viewport: { x: number; y: number; zoom: number }) => void;
  onVisible: (ready: boolean) => void;
}) {
  const initialized = useNodesInitialized();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { fitView, getViewport } = useReactFlow();
  useEffect(() => {
    if (!initialized || width <= 0 || height <= 0) return;
    let disposed = false;
    void fitView({ padding: 0.2, maxZoom: 1 }).then((fitted) => {
      if (disposed) return;
      onVisible(true);
      if (fitted) onReady?.(getViewport());
    });
    return () => { disposed = true; };
  }, [initialized, width, height, fitView, getViewport, onReady, onVisible]);
  return null;
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
// React Flow takes delete keys anywhere on the page, so with canvases in
// panels side by side each would delete its selection. The editor takes them
// itself, for one canvas: the one used last while it is in sight, or any in
// sight when that one is not.
let lastCanvas: Element | undefined;
if (typeof document !== "undefined") {
  const track = (event: Event) => {
    if (!(event.target instanceof Element)) return;
    // Within a canvas, or within the area both editors put around it, which the asset canvas focuses.
    const canvas = event.target.closest(".react-flow") ?? event.target.closest(".interactive-story-canvas")?.querySelector(".react-flow");
    if (canvas) lastCanvas = canvas;
  };
  document.addEventListener("pointerdown", track, true);
  document.addEventListener("focusin", track, true);
}
const inSight = (element: Element) => element.isConnected && !element.closest("[hidden], .dock-parking");

/** Whether the canvas keys pressed now belong to the canvas in `within`. */
export function ownsCanvasKeys(within: Element | null | undefined): boolean {
  if (!within || !inSight(within)) return false;
  return !lastCanvas || !inSight(lastCanvas) || within.contains(lastCanvas);
}

const SPACE_CONTROL_SELECTOR = 'input, textarea, select, [contenteditable], button, a, summary, video, audio, [role="button"], [role="slider"], [role="textbox"], .nokey';

/** Temporarily use the hand tool without consuming Space from node controls. */
function useSpacePan(canvas: RefObject<HTMLDivElement | null>): boolean {
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    const reset = () => setPressed(false);
    const keydown = (event: KeyboardEvent) => {
      if ((event.code !== "Space" && event.key !== " ") || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.composedPath()[0];
      const within = canvas.current;
      if (!ownsCanvasKeys(within) || !(target instanceof Element) || (target === document.body && !lastCanvas)) return;
      if (target.closest(SPACE_CONTROL_SELECTOR)) return;
      if (target !== document.body && !within?.contains(target) && target !== within?.closest(".interactive-story-canvas")) return;
      if ([...document.querySelectorAll('[aria-modal="true"]')].some((modal) => inSight(modal) && !within?.contains(modal))) return;
      // Capture before React Flow's Space-to-select and the editor's node activation.
      event.preventDefault();
      event.stopPropagation();
      setPressed(true);
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code === "Space" || event.key === " ") reset();
    };
    const focus = () => {
      const target = document.activeElement;
      if (target?.closest(SPACE_CONTROL_SELECTOR)
        || (!canvas.current?.contains(target) && target !== canvas.current?.closest(".interactive-story-canvas"))) reset();
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", reset);
    window.addEventListener("contextmenu", reset);
    document.addEventListener("focusin", focus);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("contextmenu", reset);
      document.removeEventListener("focusin", focus);
    };
  }, [canvas]);
  return pressed;
}

/** Deletes the selection on a delete key, as React Flow does, when the keys are this canvas's. */
function DeleteKeys({ keys, canvas }: { keys: ReactFlowProps["deleteKeyCode"]; canvas: RefObject<HTMLDivElement | null> }) {
  const store = useStoreApi();
  const { deleteElements } = useReactFlow();
  const list = keys == null ? [] : Array.isArray(keys) ? keys : [keys];
  const listKey = list.join("\n");
  useEffect(() => {
    if (!list.length) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!list.includes(event.key) || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      // React Flow's own test for a field the key types into.
      const target = event.composedPath?.()[0] ?? event.target;
      if (target instanceof Element && (["INPUT", "SELECT", "TEXTAREA"].includes(target.nodeName) || target.hasAttribute("contenteditable") || target.closest(".nokey"))) return;
      if (!ownsCanvasKeys(canvas.current)) return;
      // A modal over the canvas has the keys, wherever focus fell inside it. One
      // left open in a panel out of sight isn't over anything.
      if ([...document.querySelectorAll('[aria-modal="true"]')].some((modal) => inSight(modal) && !canvas.current?.contains(modal))) return;
      const { nodes, edges } = store.getState();
      void deleteElements({ nodes: nodes.filter((node) => node.selected), edges: edges.filter((edge) => edge.selected) });
      store.setState({ nodesSelectionActive: false });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [listKey, store, deleteElements]);
  return null;
}

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
  return <button type="button" data-tooltip={t("editorCanvas.fit")} aria-label={t("editorCanvas.fit")} onClick={() => void fitCanvas()}><Maximize size={18} /></button>;
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

function measureAlignmentFrames(canvas: HTMLElement | null) {
  const zoom = canvasViewportZoom(canvas);
  const frames = new Map<string, AlignmentFrame>();
  for (const root of canvas?.querySelectorAll<HTMLElement>(".react-flow__node[data-id]") ?? []) {
    const frame = root.querySelector<HTMLElement>("[data-alignment-frame]");
    if (!frame) continue;
    const outer = root.getBoundingClientRect(), inner = frame.getBoundingClientRect();
    frames.set(root.dataset.id!, {
      x: (inner.left - outer.left) / zoom, y: (inner.top - outer.top) / zoom,
      width: inner.width / zoom, height: inner.height / zoom,
    });
  }
  return frames;
}

function canvasViewportZoom(canvas: HTMLElement | null): number {
  const viewport = canvas?.querySelector<HTMLElement>(".react-flow__viewport");
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
    <div className="react-flow__panel bottom left story-canvas-zoom">
      <button type="button" title={t("editorCanvas.zoomOut")} aria-label={t("editorCanvas.zoomOut")} onClick={() => void zoomOut()}><Minus size={14} /></button>
      <button className="story-canvas-zoom-value" type="button" title={t("editorCanvas.resetZoom")} onClick={() => void zoomTo(1)}>{Math.round(zoom * 100)}%</button>
      <button type="button" title={t("editorCanvas.zoomIn")} aria-label={t("editorCanvas.zoomIn")} onClick={() => void zoomIn()}><Plus size={14} /></button>
    </div>
  );
}
