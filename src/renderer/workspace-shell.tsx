import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref, type UIEventHandler } from "react";
import { House, PanelToggle, type IconComponent } from "./icons.js";
import type { ChatLayout } from "./chat-layout.js";

const DEFAULT_AGENT_WIDTH = 430;
const MIN_AGENT_WIDTH = 320;
const AGENT_WIDTH_STORAGE_KEY = "ohmygame-agent-width";

/** Shared chrome and layout for game and plugin workspaces. */
export function WorkspaceShell({ chatLayout, agentCollapsed, viewerCollapsed = false, onHome, onExpandAgent, homeLabel = "Home", homeIcon = House, className = "", agent, children }: {
  chatLayout: ChatLayout;
  agentCollapsed: boolean;
  viewerCollapsed?: boolean;
  onHome: () => void;
  onExpandAgent: () => void;
  homeLabel?: string;
  homeIcon?: IconComponent;
  className?: string;
  agent: ReactNode;
  children: ReactNode;
}) {
  const [agentWidth, setAgentWidth] = useState(readAgentWidth);
  const [maximumAgentWidth, setMaximumAgentWidth] = useState(DEFAULT_AGENT_WIDTH);
  const [resizingAgent, setResizingAgent] = useState(false);
  const shell = useRef<HTMLElement>(null);
  const widthRef = useRef(agentWidth);
  const resizingRef = useRef(false);
  const collapsed = agentCollapsed || viewerCollapsed;

  useEffect(() => {
    const updateMaximum = () => {
      if (window.matchMedia("(max-width: 720px)").matches) return;
      const bounds = shell.current?.getBoundingClientRect();
      if (!bounds) return;
      const maximum = maximumWidth(bounds.width);
      setMaximumAgentWidth(maximum);
      if (widthRef.current > maximum) {
        widthRef.current = maximum;
        setAgentWidth(maximum);
        saveWidth(maximum);
      }
    };
    updateMaximum();
    window.addEventListener("resize", updateMaximum);
    return () => window.removeEventListener("resize", updateMaximum);
  }, []);

  function resize(clientX: number) {
    const bounds = shell.current?.getBoundingClientRect();
    if (!bounds || !shell.current) return;
    const distance = chatLayout === "right" ? bounds.right - clientX : clientX - bounds.left;
    const width = Math.round(Math.min(maximumWidth(bounds.width), Math.max(MIN_AGENT_WIDTH, distance)));
    widthRef.current = width;
    shell.current.style.setProperty("--agent-width", `${width}px`);
  }
  function finishResize() {
    if (!resizingRef.current) return;
    resizingRef.current = false;
    setResizingAgent(false);
    setAgentWidth(widthRef.current);
    saveWidth(widthRef.current);
  }
  function resetWidth() {
    const width = Math.min(DEFAULT_AGENT_WIDTH, maximumAgentWidth);
    widthRef.current = width;
    setAgentWidth(width);
    saveWidth(width);
  }
  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = chatLayout === "left"
      ? (event.key === "ArrowLeft" ? -1 : 1)
      : (event.key === "ArrowLeft" ? 1 : -1);
    const bounds = shell.current?.getBoundingClientRect();
    if (!bounds) return;
    resize(chatLayout === "right"
      ? bounds.right - widthRef.current - direction * 16
      : bounds.left + widthRef.current + direction * 16);
    setAgentWidth(widthRef.current);
    saveWidth(widthRef.current);
  }

  return <main ref={shell} className={`workspace-shell workspace-shell-chat-${chatLayout}${agentCollapsed ? " workspace-shell-agent-collapsed" : ""}${viewerCollapsed ? " workspace-shell-viewer-collapsed" : ""}${resizingAgent ? " workspace-shell-resizing" : ""} ${className}`}
    style={{ "--agent-width": `${agentWidth}px` } as CSSProperties}>
    {resizingAgent ? <div className="workspace-resize-shield" /> : null}
    {chatLayout === "left" ? <div className="workspace-navigation-actions" role="toolbar" aria-label="Workspace navigation">
      <WorkspaceBackButton onClick={onHome} label={homeLabel} icon={homeIcon} />
      {agentCollapsed ? <button className="icon-button" type="button" onClick={onExpandAgent} title="Show agent" aria-label="Show agent"><PanelToggle size={15} /></button> : null}
    </div> : null}
    {agent}
    <div className="workspace-resizer" role="separator" aria-label="Resize agent panel" aria-orientation="vertical"
      aria-valuemin={MIN_AGENT_WIDTH} aria-valuemax={maximumAgentWidth} aria-valuenow={agentWidth}
      aria-hidden={collapsed || undefined} tabIndex={collapsed ? -1 : 0}
      onDoubleClick={resetWidth} onKeyDown={resizeWithKeyboard}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        resizingRef.current = true;
        setResizingAgent(true);
      }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX); }}
      onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); finishResize(); }}
      onPointerCancel={finishResize} onLostPointerCapture={finishResize} />
    {children}
  </main>;
}

export function WorkspaceBackButton({ onClick, label = "Home", icon: Icon = House }: { onClick: () => void; label?: string; icon?: IconComponent }) {
  return <button className="icon-button pane-header-action workspace-home-button" type="button" onClick={onClick} title={label} aria-label={label}><Icon size={14} /></button>;
}

export function WorkspaceAgentPane({ label = "Agent", title, actions, bodyRef, onScroll, children }: {
  label?: string;
  title?: ReactNode;
  actions: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  return <section className="agent-pane" aria-label={label}>
    <header className="pane-header window-drag-handle">
      <span className="workspace-navigation-drag-exclusion" aria-hidden="true" />
      {title}
      <div className="pane-header-actions">{actions}</div>
    </header>
    <div className="agent-body" ref={bodyRef} onScroll={onScroll}>{children}</div>
  </section>;
}

function readAgentWidth(): number {
  try {
    const stored = Number(localStorage.getItem(AGENT_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= MIN_AGENT_WIDTH ? stored : DEFAULT_AGENT_WIDTH;
  } catch { return DEFAULT_AGENT_WIDTH; }
}
function saveWidth(width: number) {
  try { localStorage.setItem(AGENT_WIDTH_STORAGE_KEY, String(width)); } catch { /* Layout still works without storage. */ }
}
function maximumWidth(width: number) {
  return Math.round(Math.max(MIN_AGENT_WIDTH, Math.min(width * 0.65, width - MIN_AGENT_WIDTH - 5)));
}
