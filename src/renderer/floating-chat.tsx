import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, Maximize, MessageCircle } from "./icons.js";
import { park, place } from "./panel-layout.js";
import { IconButton } from "./ui/index.js";
import { t } from "./i18n.js";
import "./floating-chat.css";

/** Turns the floating bar shows above its composer at most; the chat panel has the rest. */
const SHOWN = 3;

type Offset = { x: number; y: number };

// The floating command bar, over the middle area while the chat panel is
// closed. Turns sent from it stack above it, so a turn's progress pushes the
// thread up instead of going unseen. It drags by its top edge, folds to a pill
// so it doesn't cover the canvas, and opens into the chat panel.
export function FloatingChat({ turnCount, thread, running, attention, onExpand, input }: {
  /** The conversation's turns so far; only those after the bar opens show. */
  turnCount: number;
  /** The turns from `since` on, as the chat panel shows them. */
  thread: (since: number) => ReactNode;
  running: boolean;
  /** Something waits on an answer, such as an approval; the bar unfolds for it. */
  attention: boolean;
  onExpand: () => void;
  /**
   * The composer and the cards that wait on an answer, rendered elsewhere into
   * this node; the bar holds it, folded too, so nothing typed or picked is lost.
   */
  input: HTMLElement;
}) {
  const root = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState(turnCount);
  const [folded, setFolded] = useState(false);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const latestOffset = useRef(offset);
  latestOffset.current = offset;
  const drag = useRef<{ x: number; y: number; from: Offset }>(undefined);
  // A conversation restored to an earlier turn starts the bar's thread there.
  if (turnCount < opened) setOpened(turnCount);
  const since = Math.max(Math.min(opened, turnCount), turnCount - SHOWN);
  const shown = !folded && turnCount > since;

  useLayoutEffect(() => {
    if (holder.current) place(holder.current, input);
    return () => park(input);
  }, [input]);

  useEffect(() => { if (attention) setFolded(false); }, [attention]);

  // The latest turn stays in view as it streams in.
  useEffect(() => {
    const element = threadRef.current;
    if (!element) return;
    const follow = () => element.scrollTo({ top: element.scrollHeight });
    follow();
    const observer = new MutationObserver(follow);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [shown]);

  // Keeps the bar inside the area it floats over, wherever it was dragged.
  function clamp(wanted: Offset): Offset {
    const box = root.current?.getBoundingClientRect();
    const area = root.current?.parentElement?.getBoundingClientRect();
    if (!box || !area) return wanted;
    const current = latestOffset.current;
    // The bar's resting place, without the offset, bounds how far it can go.
    const restLeft = box.left - current.x;
    const restTop = box.top - current.y;
    return {
      x: Math.min(Math.max(wanted.x, area.left + 8 - restLeft), area.right - 8 - box.width - restLeft),
      y: Math.min(Math.max(wanted.y, area.top + 8 - restTop), area.bottom - 8 - box.height - restTop),
    };
  }

  // At rest at the bottom it tells the area how much room it takes there, so
  // a board's bottom toolbar moves up above it. Dragged away, it takes none,
  // and growing as turns arrive keeps it inside the area.
  const resting = offset.x === 0 && offset.y === 0;
  useEffect(() => {
    const element = root.current;
    const area = element?.parentElement;
    if (!element || !area) return;
    const clear = () => area.style.removeProperty("--floating-chat-clearance");
    const measure = () => {
      if (resting) area.style.setProperty("--floating-chat-clearance", `${Math.round(element.getBoundingClientRect().height)}px`);
      else {
        const next = clamp(latestOffset.current);
        if (next.x !== latestOffset.current.x || next.y !== latestOffset.current.y) setOffset(next);
      }
    };
    if (!resting) clear();
    measure();
    if (typeof ResizeObserver === "undefined") return clear;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(area);
    return () => { observer.disconnect(); clear(); };
  }, [resting, folded]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = { x: event.clientX, y: event.clientY, from: offset };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const start = drag.current;
    if (!start) return;
    setOffset(clamp({ x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y }));
  };
  const onPointerUp = () => { drag.current = undefined; };
  const fold = () => { setFolded(true); setOffset({ x: 0, y: 0 }); };

  return (
    <div ref={root} className={`floating-chat${folded ? " is-folded" : ""}${shown ? " has-thread" : ""}`}
      style={folded ? undefined : { translate: `${offset.x}px ${offset.y}px` }} role="region" aria-label={t("floatingChat.label")}>
      {folded ? (
        <button type="button" className="floating-chat-pill" onClick={() => setFolded(false)}>
          <MessageCircle size={15} />
          <span>{running ? t("floatingChat.working") : t("floatingChat.ask")}</span>
          {running ? <span className="floating-chat-dot" aria-hidden="true" /> : null}
        </button>
      ) : (
        <div className="floating-chat-grip" title={t("floatingChat.grip")}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onDoubleClick={() => setOffset({ x: 0, y: 0 })}>
          <span className="floating-chat-handle" aria-hidden="true" />
          <IconButton size="sm" label={t("floatingChat.expand")} onClick={onExpand}><Maximize size={14} /></IconButton>
          {/* Folded, it goes back to the bottom middle as a pill. */}
          <IconButton size="sm" label={t("floatingChat.fold")} onClick={fold}><ChevronDown size={14} /></IconButton>
        </div>
      )}
      {shown ? <div ref={threadRef} className="floating-chat-thread timeline">{thread(since)}</div> : null}
      {/* Folded, the composer stays here, out of sight, so it keeps its state. */}
      <div ref={holder} className="floating-chat-input" hidden={folded} />
    </div>
  );
}
