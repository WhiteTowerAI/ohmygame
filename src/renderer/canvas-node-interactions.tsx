import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  useNodeId,
  useViewport,
  type EdgeProps,
} from "@xyflow/react";
import { Maximize, Plus, Scissors, X } from "./icons.js";
import { t } from "./i18n.js";

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
  const { zoom } = useViewport();
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
        <Plus size={12} />
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
    timer.current = setTimeout(() => setHover("ready"), 550);
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
            ...(active
              ? { stroke: "var(--theme-accent)", strokeWidth: 2 }
              : {}),
          }}
        />
        {hovered ? <path className="canvas-edge-pulse" d={path} /> : null}
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
  const anchor = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(true);
  const close = () => setExpanded(false);
  useLayoutEffect(() => {
    if (expanded) return;
    const element = anchor.current;
    if (!element) return;
    const update = () => {
      // Convert the viewport overflow back into canvas units. The card stays anchored to its node.
      // Clear the previous clamp before measuring, including a zero-width hidden viewport.
      element.style.removeProperty("--canvas-composer-max-width");
      let rect = element.getBoundingClientRect();
      if (window.innerWidth <= 24 || !rect.width || !element.offsetWidth)
        return;
      const scale = rect.width / element.offsetWidth;
      element.style.setProperty(
        "--canvas-composer-max-width",
        `${Math.max(0, window.innerWidth - 24) / scale}px`,
      );
      rect = element.getBoundingClientRect();
      const shift =
        (Math.max(0, 12 - rect.left) -
          Math.max(0, rect.right - window.innerWidth + 12)) /
        scale;
      if (editor.current)
        editor.current.style.transform = `translateX(${shift}px)`;
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [expanded, children]);
  useEffect(() => {
    if (actions?.hidden) close();
  }, [actions?.hidden]);
  useEffect(() => {
    if (!expanded) return;
    editor.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => {
      if (restoreFocus.current) expandButton.current?.focus();
    };
  }, [expanded]);
  const keyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Prompt editing must never trigger Delete or board undo behind the dialog.
    event.stopPropagation();
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    const root = editor.current;
    if (event.key !== "Tab" || !root || !root.contains(document.activeElement))
      return;
    const items = [
      ...root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
      ),
    ];
    const first = items[0],
      last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  const content = (
    <div
      ref={editor}
      className={`${className} canvas-composer${expanded ? " is-expanded" : ""}`}
    >
      <div className="canvas-composer-toolbar">
        {nodeId && actions?.canPickReferences(nodeId) ? (
          <button
            type="button"
            onClick={() => {
              restoreFocus.current = false;
              close();
              actions.pickReferences(nodeId);
            }}
          >
            {t("canvasInteraction.canvasReference")}
          </button>
        ) : null}
        <button
          ref={expanded ? undefined : expandButton}
          type="button"
          title={t(
            expanded ? "canvas.backToCanvas" : "canvasInteraction.expandPrompt",
          )}
          aria-label={t(
            expanded ? "canvas.backToCanvas" : "canvasInteraction.expandPrompt",
          )}
          onClick={() => {
            restoreFocus.current = true;
            setExpanded(!expanded);
          }}
        >
          {expanded ? <X size={15} /> : <Maximize size={15} />}
        </button>
      </div>
      {children}
    </div>
  );
  return (
    <div ref={anchor} className="canvas-composer-anchor">
      {expanded
        ? createPortal(
            <div
              className="canvas-composer-backdrop nodrag nowheel nokey"
              onKeyDown={keyboard}
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) close();
              }}
            >
              <section
                role="dialog"
                aria-modal="true"
                aria-label={t("canvasInteraction.promptEditor")}
              >
                {content}
              </section>
            </div>,
            document.body,
          )
        : content}
    </div>
  );
}
