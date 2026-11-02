import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  useNodeId,
  useStore,
  type EdgeProps,
  type ReactFlowState,
} from "@xyflow/react";
import { Maximize, MousePointer2, Plus, Scissors } from "./icons.js";
import { t } from "./i18n.js";
import { Button, Dialog, IconButton } from "./ui/index.js";

export const CANVAS_CONNECTION_DRAG_THRESHOLD = 4;
export type CanvasPortType = "source" | "target";
export const CanvasInteractions = createContext<
  | {
      openPort(
        nodeId: string,
        type: CanvasPortType,
        position: { x: number; y: number },
      ): void;
      pickReferences(nodeId: string): void;
      canPickReferences(nodeId: string): boolean;
      portsDisabled: boolean;
      hidden?: boolean;
      disconnect(edgeId: string): void;
      canDisconnect(targetId: string): boolean;
    }
  | undefined
>(undefined);

const selectZoom = (state: ReactFlowState) => state.transform[2];

/** Handle bounds anchor edges to the node; the icon and pointer area extend outside. */
export function CanvasPort({
  type,
  id,
  className = "",
}: {
  type: CanvasPortType;
  id?: string;
  className?: string;
}) {
  const nodeId = useNodeId();
  const actions = useContext(CanvasInteractions);
  // Subscribe to zoom only, so panning does not re-render every port.
  const zoom = useStore(selectZoom);
  const pointer = useRef<
    { x: number; y: number; dragged: boolean } | undefined
  >(undefined);
  const disabled = actions?.portsDisabled ?? false;
  const open = (position: { x: number; y: number }) => {
    if (nodeId && !disabled) actions?.openPort(nodeId, type, position);
  };
  const label = t(
    type === "target"
      ? "canvasInteraction.addContext"
      : "canvasInteraction.continueFromNode",
  );
  return (
    <Handle
      id={id}
      type={type}
      position={type === "target" ? Position.Left : Position.Right}
      className={`canvas-port ${className}`}
      style={
        {
          "--canvas-port-size": `${Math.min(72, Math.max(28, 44 / zoom))}px`,
        } as CSSProperties
      }
      isConnectable={!disabled}
      isConnectableStart={!disabled}
      isConnectableEnd={!disabled}
      role="button"
      tabIndex={disabled ? -1 : 0}
      title={label}
      aria-label={label}
      aria-disabled={disabled}
      onPointerDown={(event) => {
        pointer.current = {
          x: event.clientX,
          y: event.clientY,
          dragged: false,
        };
      }}
      onPointerMove={(event) => {
        if (
          pointer.current &&
          event.buttons &&
          Math.hypot(
            event.clientX - pointer.current.x,
            event.clientY - pointer.current.y,
          ) > CANVAS_CONNECTION_DRAG_THRESHOLD
        )
          pointer.current.dragged = true;
      }}
      onClick={(event) => {
        event.stopPropagation();
        // A cancelled drag may return to its start, so retain movement as well as release distance.
        if (
          pointer.current &&
          (pointer.current.dragged ||
            Math.hypot(
              event.clientX - pointer.current.x,
              event.clientY - pointer.current.y,
            ) > CANVAS_CONNECTION_DRAG_THRESHOLD)
        )
          return;
        open({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        open({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      }}
    >
      <span className="canvas-port-icon">
        <Plus size={14} />
      </span>
    </Handle>
  );
}

function CanvasReferenceEdge(props: EdgeProps) {
  const actions = useContext(CanvasInteractions);
  const [hover, setHover] = useState<"idle" | "waiting" | "ready">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const enter = () => {
    clearTimeout(timer.current);
    if (hover === "ready") return;
    setHover("waiting");
    timer.current = setTimeout(() => setHover("ready"), 300);
  };
  const exit = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover("idle"), 250);
  };
  const hovered = hover !== "idle";
  const [path, x, y] = getBezierPath(props);
  const active = hovered || props.selected;
  return (
    <>
      <g onMouseEnter={enter} onMouseLeave={exit}>
        <BaseEdge
          id={props.id}
          path={path}
          markerEnd={props.markerEnd}
          interactionWidth={24}
          style={{
            ...props.style,
            ...(active ? { stroke: "var(--color-ink)", strokeWidth: 2 } : {}),
          }}
        />
      </g>
      {(hover === "ready" || props.selected) &&
      actions?.canDisconnect(props.target) ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="canvas-edge-disconnect nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
            }}
            title={t("canvasInteraction.disconnect")}
            aria-label={t("canvasInteraction.disconnect")}
            onMouseEnter={enter}
            onMouseLeave={exit}
            onFocus={enter}
            onClick={(event) => {
              event.stopPropagation();
              actions.disconnect(props.id);
            }}
          >
            <Scissors size={16} />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
export const CANVAS_REFERENCE_EDGE_TYPES = { reference: CanvasReferenceEdge };

/** Keep all references, model settings and generation controls available in either view. */
export function CanvasComposer({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const actions = useContext(CanvasInteractions);
  const nodeId = useNodeId();
  const editor = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(true);
  const close = () => setExpanded(false);
  useEffect(() => {
    if (actions?.hidden) close();
  }, [actions?.hidden]);
  useEffect(() => {
    if (!expanded) return;
    // The dialog focuses its first control; the prompt is what was opened.
    editor.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => {
      if (restoreFocus.current) expandButton.current?.focus();
    };
  }, [expanded]);
  // The dialog is portaled, but its keys still reach the node and canvas
  // through React. Tab stays with the dialog's focus trap.
  const keyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") return;
    event.stopPropagation();
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      close();
    }
  };
  const pickLabel = t("canvasInteraction.canvasReference");
  const pick =
    nodeId && actions?.canPickReferences(nodeId)
      ? () => {
          restoreFocus.current = false;
          close();
          actions.pickReferences(nodeId);
        }
      : undefined;
  return (
    <div
      className="canvas-composer-anchor"
      onKeyDown={expanded ? keyboard : undefined}
    >
      {expanded ? (
        <Dialog
          open
          size="lg"
          title={t("canvasInteraction.promptEditor")}
          onClose={close}
        >
          <div
            ref={editor}
            className={`${className} canvas-composer is-expanded nokey`}
          >
            {pick ? (
              <div className="canvas-composer-toolbar">
                <Button size="sm" variant="ghost" onClick={pick}>
                  <MousePointer2 size={14} />
                  {pickLabel}
                </Button>
              </div>
            ) : null}
            {children}
          </div>
        </Dialog>
      ) : (
        <div className={`${className} canvas-composer`}>
          <div className="canvas-composer-toolbar">
            {pick ? (
              <IconButton size="sm" label={pickLabel} onClick={pick}>
                <MousePointer2 size={14} />
              </IconButton>
            ) : null}
            <IconButton
              ref={expandButton}
              size="sm"
              label={t("canvasInteraction.expandPrompt")}
              onClick={() => {
                restoreFocus.current = true;
                setExpanded(true);
              }}
            >
              <Maximize size={14} />
            </IconButton>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
