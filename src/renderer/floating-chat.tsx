import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, Maximize, MessageCircle } from "./icons.js";
import { IconButton } from "./ui/index.js";
import { t } from "./i18n.js";
import "./floating-chat.css";

/** Turns the floating bar shows above its composer at most; the chat panel has the rest. */
const SHOWN = 3;

// The floating command bar, over the middle area while the chat panel is
// closed. Turns sent from it stack above it, so a turn's progress pushes the
// thread up instead of going unseen. It drags by its top edge, folds to a pill
// so it doesn't cover the canvas, and opens into the chat panel.
export function FloatingChat({ turnCount, thread, running, attention, onExpand, children }: {
  /** The conversation's turns so far; only those after the bar opens show. */
  turnCount: number;
  /** The turns from `since` on, as the chat panel shows them. */
  thread: (since: number) => ReactNode;
  running: boolean;
  /** Something waits on an answer, such as an approval; the bar unfolds for it. */
  attention: boolean;
  onExpand: () => void;
  /** The composer, and the cards that wait on an answer. */
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const [opened] = useState(turnCount);
  const [folded, setFolded] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } }>(undefined);
  const since = Math.max(opened, turnCount - SHOWN);
  const shown = turnCount > since;

  useEffect(() => { if (attention) setFolded(false); }, [attention]);
  // The latest turn stays in view as it grows.
  useEffect(() => {
    const element = threadRef.current;
    if (!element) return;
    const follow = () => element.scrollTo({ top: element.scrollHeight });
    follow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(follow);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [shown, since]);

  // Dragging moves it within the area it floats over, never off its edges.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = { x: event.clientX, y: event.clientY, from: offset };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const start = drag.current;
    const box = root.current?.getBoundingClientRect();
    const area = root.current?.parentElement?.getBoundingClientRect();
    if (!start || !box || !area) return;
    const x = start.from.x + event.clientX - start.x;
    const y = start.from.y + event.clientY - start.y;
    // The bar's resting place, without the offset, bounds how far it can go.
    const restLeft = box.left - offset.x;
    const restTop = box.top - offset.y;
    setOffset({
      x: Math.min(Math.max(x, area.left + 8 - restLeft), area.right - 8 - box.width - restLeft),
      y: Math.min(Math.max(y, area.top + 8 - restTop), area.bottom - 8 - box.height - restTop),
    });
  };
  const onPointerUp = () => { drag.current = undefined; };
  const style = { translate: `${offset.x}px ${offset.y}px` };

  if (folded) {
    return (
      <div ref={root} className="floating-chat is-folded">
        <button type="button" className="floating-chat-pill" onClick={() => setFolded(false)}>
          <MessageCircle size={15} />
          <span>{running ? t("floatingChat.working") : t("floatingChat.ask")}</span>
          {running ? <span className="floating-chat-dot" aria-hidden="true" /> : null}
        </button>
      </div>
    );
  }

  return (
    <div ref={root} className={`floating-chat${shown ? " has-thread" : ""}`} style={style} role="region" aria-label={t("floatingChat.label")}>
      <div className="floating-chat-grip" title={t("floatingChat.grip")}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onDoubleClick={() => setOffset({ x: 0, y: 0 })}>
        <span className="floating-chat-handle" aria-hidden="true" />
        <IconButton size="sm" label={t("floatingChat.expand")} onClick={onExpand}><Maximize size={14} /></IconButton>
        {/* Folded, it goes back to the bottom middle as a pill. */}
        <IconButton size="sm" label={t("floatingChat.fold")} onClick={() => { setFolded(true); setOffset({ x: 0, y: 0 }); }}><ChevronDown size={14} /></IconButton>
      </div>
      {shown ? <div ref={threadRef} className="floating-chat-thread timeline">{thread(since)}</div> : null}
      <div className="floating-chat-input">{children}</div>
    </div>
  );
}
