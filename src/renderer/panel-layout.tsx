import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "./icons.js";
import { ContextMenu, DropdownMenu, IconButton, type MenuEntry } from "./ui/index.js";
import { t } from "./i18n.js";
import "./panel-layout.css";

// An engine-style panel layout: four areas around the project (left, center,
// right, bottom), each a group of tabs. Panels drag between areas or to an
// empty edge, close from their tab, and come back from a menu. The layout is
// plain data, so presets and plugins can describe one.

export type AreaId = "left" | "center" | "right" | "bottom";
const areaLabel = (area: AreaId): string => t(`panels.area.${area}`);
const SIDES = ["left", "right", "bottom"] as const;

export interface AreaState {
  panels: string[];
  active?: string;
  /** Width for left and right, height for bottom. Kept while the area is empty. */
  size: number;
}
export type Layout = Record<AreaId, AreaState>;

export interface PanelDef {
  id: string;
  title: string;
  icon: ReactNode;
  content: ReactNode;
  /** Where it opens when it isn't in the layout. */
  home: AreaId;
  /** Tool panels get padding and scroll; surfaces fill their area edge to edge. */
  padded?: boolean;
  /** A count shown on the tab. */
  badge?: number;
  /** The plugin that adds it. */
  source?: string;
}

const MIN_SIZE = 200;

// Each panel's toolbar lives in its area's tab strip, so a panel has one row of
// chrome. A panel puts its controls there with <PanelToolbar>.
const ToolbarSlot = createContext<HTMLElement | null>(null);

export function PanelToolbar({ children }: { children: ReactNode }) {
  const slot = useContext(ToolbarSlot);
  return slot ? createPortal(children, slot) : null;
}

/**
 * A view rendered outside the layout. It portals into these two nodes, and
 * <PanelMount> moves them into whichever panel shows it, so moving a panel
 * to another area, or closing it, keeps the view's state.
 */
export interface PanelNodes {
  body: HTMLDivElement;
  toolbar: HTMLDivElement;
}

export function createPanelNodes(): PanelNodes {
  const body = document.createElement("div");
  body.className = "dock-view";
  const toolbar = document.createElement("div");
  toolbar.className = "dock-view-toolbar";
  return { body, toolbar };
}

/** A panel's content that shows a view from outside the layout. */
export function PanelMount({ nodes }: { nodes: PanelNodes }) {
  const host = useRef<HTMLDivElement>(null);
  const toolbar = useContext(ToolbarSlot);
  useLayoutEffect(() => { host.current?.append(nodes.body); }, [nodes]);
  useLayoutEffect(() => { toolbar?.append(nodes.toolbar); }, [toolbar, nodes]);
  return <div ref={host} className="dock-mount" />;
}

export function areaOf(layout: Layout, id: string): AreaId | undefined {
  return (Object.keys(layout) as AreaId[]).find((area) => layout[area].panels.includes(id));
}

/** Takes `id` out of its area; the tab beside it becomes active. */
export function closePanel(layout: Layout, id: string): Layout {
  const from = areaOf(layout, id);
  if (!from) return layout;
  const { panels, active } = layout[from];
  const index = panels.indexOf(id);
  const rest = panels.filter((panel) => panel !== id);
  return { ...layout, [from]: { ...layout[from], panels: rest, active: active === id ? rest[Math.min(index, rest.length - 1)] : active } };
}

/** Moves `id` into `to`, before `before` or at the end, and makes it the active tab. */
export function movePanel(layout: Layout, id: string, to: AreaId, before?: string): Layout {
  if (before === id) return layout;
  const next = closePanel(layout, id);
  const panels = [...next[to].panels];
  const index = before ? panels.indexOf(before) : -1;
  panels.splice(index < 0 ? panels.length : index, 0, id);
  return { ...next, [to]: { ...next[to], panels, active: id } };
}

/** Brings `id` forward where it is, or opens it in `home`. */
export function showPanel(layout: Layout, id: string, home: AreaId): Layout {
  const area = areaOf(layout, id);
  return area ? { ...layout, [area]: { ...layout[area], active: id } } : movePanel(layout, id, home);
}

/** The panels the person can see now: each area's active tab. */
export function visiblePanels(layout: Layout, known: ReadonlySet<string>): string[] {
  return Object.values(layout).flatMap((area) => {
    const active = area.active && known.has(area.active) ? area.active : area.panels.find((id) => known.has(id));
    return active ? [active] : [];
  });
}

export function PanelLayout({ layout, panels, onChange, onActivate, overlay, empty }: {
  layout: Layout;
  /** Every panel that can be shown; ids in the layout without one are skipped. */
  panels: readonly PanelDef[];
  onChange: (layout: Layout) => void;
  /** A panel was brought forward or clicked into. */
  onActivate?: (id: string) => void;
  /** Floats over the center area, such as the command bar. */
  overlay?: ReactNode;
  /** What the center shows with no panels in it. */
  empty: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string>();
  const [target, setTarget] = useState<{ area: AreaId; before?: string }>();
  const [slots, setSlots] = useState<Record<string, HTMLElement | null>>({});
  // Stable ref callbacks, so a render doesn't detach and reattach every slot.
  const slotRefs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const slotRef = (id: string) => {
    let ref = slotRefs.current.get(id);
    if (!ref) {
      ref = (element) => setSlots((current) => current[id] === element ? current : { ...current, [id]: element });
      slotRefs.current.set(id, ref);
    }
    return ref;
  };
  const byId = new Map(panels.map((panel) => [panel.id, panel]));
  const known = new Set(byId.keys());
  const shown = (area: AreaId) => layout[area].panels.filter((id) => known.has(id));
  const present = SIDES.filter((area) => shown(area).length);
  const has = (area: AreaId) => area === "center" || present.includes(area as (typeof SIDES)[number]);

  const left = has("left") ? `minmax(160px, ${layout.left.size}px)` : "", right = has("right") ? `minmax(160px, ${layout.right.size}px)` : "";
  const row = (middle: string) => [has("left") ? "left" : "", middle, has("right") ? "right" : ""].filter(Boolean).join(" ");
  const style: CSSProperties = {
    gridTemplateColumns: [left, "minmax(320px, 1fr)", right].filter(Boolean).join(" "),
    gridTemplateRows: has("bottom") ? `minmax(160px, 1fr) minmax(120px, ${layout.bottom.size}px)` : "minmax(0, 1fr)",
    gridTemplateAreas: has("bottom") ? `"${row("center")}" "${row("bottom")}"` : `"${row("center")}"`,
  };

  function drop(event: DragEvent, area: AreaId, before?: string) {
    event.preventDefault();
    event.stopPropagation();
    if (dragging) {
      onChange(movePanel(layout, dragging, area, before));
      onActivate?.(dragging);
    }
    setDragging(undefined);
    setTarget(undefined);
  }
  function over(event: DragEvent, area: AreaId, before?: string) {
    if (!dragging) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    if (target?.area !== area || target.before !== before) setTarget({ area, before });
  }
  const activate = (area: AreaId, id: string) => {
    onChange({ ...layout, [area]: { ...layout[area], active: id } });
    onActivate?.(id);
  };
  const close = (id: string) => onChange(closePanel(layout, id));
  // The + menu: panels not in the layout, opened in this area.
  const closed = panels.filter((panel) => !areaOf(layout, panel.id));
  const addMenu = (area: AreaId): MenuEntry[] => {
    const item = (panel: PanelDef): MenuEntry => ({
      label: panel.title, icon: panel.icon,
      onSelect: () => { onChange(movePanel(layout, panel.id, area)); onActivate?.(panel.id); },
    });
    const plugins = closed.filter((panel) => panel.source);
    return [...closed.filter((panel) => !panel.source).map(item), ...(plugins.length ? [{ heading: t("panels.fromPlugins") }, ...plugins.map(item)] : [])];
  };

  function resize(area: (typeof SIDES)[number], event: React.PointerEvent) {
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return;
    const raw = area === "left" ? event.clientX - bounds.left : area === "right" ? bounds.right - event.clientX : bounds.bottom - event.clientY;
    const limit = (area === "bottom" ? bounds.height : bounds.width) * 0.6;
    onChange({ ...layout, [area]: { ...layout[area], size: Math.round(Math.min(limit, Math.max(MIN_SIZE, raw))) } });
  }

  return (
    <div ref={root} className={`dock${dragging ? " is-dragging" : ""}`} style={style}
      onDragEnd={() => { setDragging(undefined); setTarget(undefined); }}>
      {(["left", "center", "right", "bottom"] as const).filter(has).map((area) => {
        const ids = shown(area);
        const active = ids.includes(layout[area].active ?? "") ? layout[area].active : ids[0];
        return (
          <section key={area} className={`dock-area dock-area-${area}${target?.area === area && !target.before ? " is-drop" : ""}`}
            style={{ gridArea: area }} aria-label={areaLabel(area)}
            onPointerDownCapture={(event) => {
              if (active && !(event.target as Element).closest(".dock-resizer")) onActivate?.(active);
            }}>
            <div className="dock-tabs" role="tablist" aria-label={t("panels.areaPanels", { area: areaLabel(area) })}
              onDragOver={(event) => over(event, area)} onDrop={(event) => drop(event, area)}>
              {ids.map((id) => {
                const panel = byId.get(id)!;
                const moves = (["left", "center", "right", "bottom"] as const).filter((to) => to !== area)
                  .map((to) => ({ label: t("panels.moveTo", { area: areaLabel(to) }), onSelect: () => { onChange(movePanel(layout, id, to)); onActivate?.(id); } }));
                return (
                  <ContextMenu key={id} items={[...moves, "separator", { label: t("common.close"), onSelect: () => close(id) }]}>
                    <div className={`dock-tab${id === active ? " is-active" : ""}${dragging === id ? " is-dragged" : ""}${target?.area === area && target.before === id ? " is-drop-before" : ""}`}
                      draggable title={panel.source ? t("panels.fromPlugin", { title: panel.title, plugin: panel.source }) : panel.title}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", panel.title);
                        event.dataTransfer.effectAllowed = "move";
                        setDragging(id);
                      }}
                      onDragOver={(event) => over(event, area, id)} onDrop={(event) => drop(event, area, id)}>
                      <button type="button" role="tab" aria-selected={id === active} className="dock-tab-button"
                        onClick={() => activate(area, id)}>
                        <span className="dock-tab-icon" aria-hidden="true">{panel.icon}</span>
                        <span className="dock-tab-label">{panel.title}</span>
                        {panel.badge ? <span className="dock-tab-badge">{panel.badge}</span> : null}
                      </button>
                      <button type="button" className="dock-tab-close" aria-label={t("panels.close", { title: panel.title })} onClick={() => close(id)}>
                        <X size={12} />
                      </button>
                    </div>
                  </ContextMenu>
                );
              })}
              {closed.length ? (
                <DropdownMenu trigger={(props) => (
                  <IconButton {...props} size="sm" label={t("panels.add")} className="dock-add"><Plus size={14} /></IconButton>
                )} items={addMenu(area)} />
              ) : null}
              {ids.map((id) => <div key={id} ref={slotRef(id)} className="dock-toolbar" hidden={id !== active} />)}
            </div>
            <div className={`dock-body${area === "center" && overlay ? " has-float" : ""}`}
              onDragOver={(event) => over(event, area)} onDrop={(event) => drop(event, area)}>
              {ids.map((id) => {
                const panel = byId.get(id)!;
                return (
                  <div key={id} role="tabpanel" aria-label={panel.title} hidden={id !== active}
                    className={`dock-panel${panel.padded ? " is-padded" : ""}`}>
                    <ToolbarSlot.Provider value={slots[id] ?? null}>{panel.content}</ToolbarSlot.Provider>
                  </div>
                );
              })}
              {ids.length ? null : empty}
              {area === "center" ? overlay : null}
            </div>
            {area === "center" ? null : (
              <div className={`dock-resizer dock-resizer-${area}`} role="separator" tabIndex={0}
                aria-orientation={area === "bottom" ? "horizontal" : "vertical"} aria-label={t("panels.resize", { area: areaLabel(area) })}
                aria-valuenow={layout[area].size}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  document.documentElement.classList.add("is-resizing-dock");
                }}
                onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(area, event); }}
                onLostPointerCapture={() => document.documentElement.classList.remove("is-resizing-dock")}
                onKeyDown={(event) => {
                  const grow = area === "left" ? "ArrowRight" : area === "right" ? "ArrowLeft" : "ArrowUp";
                  const shrink = area === "left" ? "ArrowLeft" : area === "right" ? "ArrowRight" : "ArrowDown";
                  if (event.key !== grow && event.key !== shrink) return;
                  event.preventDefault();
                  const size = layout[area].size + (event.key === grow ? 16 : -16);
                  onChange({ ...layout, [area]: { ...layout[area], size: Math.max(MIN_SIZE, size) } });
                }} />
            )}
          </section>
        );
      })}
      {/* While a tab is dragged, each missing side shows where it would open. */}
      {dragging ? SIDES.filter((area) => !has(area)).map((area) => (
        <div key={area} className={`dock-zone dock-zone-${area}${target?.area === area ? " is-drop" : ""}`}
          onDragOver={(event) => over(event, area)} onDrop={(event) => drop(event, area)}>
          {t("panels.moveTo", { area: areaLabel(area) })}
        </div>
      )) : null}
    </div>
  );
}
