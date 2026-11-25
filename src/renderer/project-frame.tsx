import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ProjectState } from "../shared/contracts.js";
import { editableTarget, isMac } from "./command-menu.js";
import { ChevronDown, PanelToggle } from "./icons.js";
import { place, Titlebar, type TitlebarNodes } from "./panel-layout.js";
import { DropdownMenu, IconButton, type MenuEntry } from "./ui/index.js";
import { t } from "./i18n.js";
import "./project-frame.css";

const RAIL_HIDDEN_KEY = "ohmygame-project-rail-hidden";

/** Where <ProjectTop> puts the project's name and its actions. */
const TopSlots = createContext<{ name: HTMLElement; actions: HTMLElement } | null>(null);

function titleNode(className: string): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  return node;
}

/**
 * The project workspace: the project rail and the body. The project's name
 * and actions make the title bar; a panel layout that reaches the window's
 * top carries them in its top strips, beside the panels' tabs, and the frame
 * shows its own title bar row otherwise. The rail is the collapsed sidebar,
 * so it takes the sidebar's collapsed styles; the title bar's toggle, or
 * ⌘B / Ctrl+B, hides it.
 */
export function ProjectFrame({ rail, top, children }: { rail: ReactNode; top: ReactNode; children: ReactNode }) {
  const [railHidden, setRailHidden] = useState(() => localStorage.getItem(RAIL_HIDDEN_KEY) === "true");
  const startHolder = useRef<HTMLDivElement>(null);
  const endHolder = useRef<HTMLDivElement>(null);
  const [nodes] = useState(() => {
    const start = titleNode("project-title-start");
    const toggle = titleNode("project-title-toggle");
    const name = titleNode("project-title-name");
    start.append(toggle, name);
    return { start, toggle, name, end: titleNode("project-title-end") };
  });
  const titlebar = useMemo<TitlebarNodes>(() => ({
    start: nodes.start,
    end: nodes.end,
    release: () => {
      if (startHolder.current) place(startHolder.current, nodes.start);
      if (endHolder.current) place(endHolder.current, nodes.end);
    },
  }), [nodes]);
  const slots = useMemo(() => ({ name: nodes.name, actions: nodes.end }), [nodes]);

  // The frame's own row holds them until a layout takes them; a layout's
  // effects run first, so whatever it has taken stays where it is.
  useLayoutEffect(() => {
    if (!nodes.start.parentNode) titlebar.release();
  }, [nodes, titlebar]);

  const toggleRail = () => setRailHidden((hidden) => {
    localStorage.setItem(RAIL_HIDDEN_KEY, String(!hidden));
    return !hidden;
  });
  useEffect(() => {
    const mac = isMac();
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || event.key.toLowerCase() !== "b") return;
      if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) || editableTarget(event.target)) return;
      event.preventDefault();
      toggleRail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleLabel = railHidden ? t("sidebar.showRail") : t("sidebar.hideRail");
  return (
    <div className={`project-frame is-sidebar-collapsed${railHidden ? " is-rail-hidden" : ""}`}>
      {rail}
      <header className="project-top">
        <div ref={startHolder} className="project-top-start" />
        <div ref={endHolder} className="project-top-end" />
      </header>
      <div className="project-body">
        <Titlebar.Provider value={titlebar}>
          <TopSlots.Provider value={slots}>
            {top}
            {children}
          </TopSlots.Provider>
        </Titlebar.Provider>
      </div>
      {createPortal(<IconButton size="sm" label={toggleLabel} aria-expanded={!railHidden} onClick={toggleRail}>
        <PanelToggle size={16} />
      </IconButton>, nodes.toggle)}
    </div>
  );
}

/**
 * The project's name as its menu (the rail shows only its cover), a status
 * only when it needs attention, and the project's actions. In a frame they
 * start and end its title bar; anywhere else they render in place.
 */
export function ProjectTop({ name, icon, menu, status, children }: { name: string; icon?: ReactNode; menu: readonly MenuEntry[]; status?: ReactNode; children?: ReactNode }) {
  const slots = useContext(TopSlots);
  const title = <>
    <DropdownMenu placement="bottom-start" items={menu} trigger={(props) => (
      <button type="button" {...props} className="project-name" title={name}>
        {icon}<span>{name}</span><ChevronDown size={12} />
      </button>
    )} />
    {status ? <span className="project-status" role="status">{status}</span> : null}
  </>;
  if (!slots) return <>{title}<span className="project-top-spacer" />{children}</>;
  return <>{createPortal(title, slots.name)}{createPortal(children ?? null, slots.actions)}</>;
}

/**
 * The top bar's Publish button. The app publishes games that play as a web
 * page (`builtIn`); plugins add their own ways (`plugins` of them). An asset
 * canvas with none has nothing to publish, and Godot and plugin projects with
 * none can't publish yet. It waits while the agent works.
 */
export function publishAction(project: Pick<ProjectState, "type" | "pluginType">, { publishing, agentBusy, plugins = 0 }: { publishing: boolean; agentBusy: boolean; plugins?: number }): { disabled: boolean; label: string; builtIn: boolean } | undefined {
  const builtIn = project.type !== "asset-canvas" && project.type !== "godot-game" && project.pluginType?.preview !== "native";
  if (project.type === "asset-canvas" && !plugins) return undefined;
  return {
    disabled: (!builtIn && !plugins) || publishing || agentBusy,
    label: project.type === "godot-game" && !plugins ? t("workspace.godotPublishing") : publishing ? t("workspace.publishing") : t("workspace.publish"),
    builtIn,
  };
}
