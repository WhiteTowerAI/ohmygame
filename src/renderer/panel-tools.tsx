import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { DropdownMenu, type MenuEntry } from "./ui/index.js";

// A panel's toolbar shares its area's tab strip. When the strip is too narrow
// for it, even with the other tabs down to their icons, the strip folds the
// panel's tools into a menu one at a time, lowest priority first (see
// DockTabStrip in panel-layout.tsx). A panel marks what may fold with
// <PanelTool>, and its own ··· menu becomes a <PanelToolsMenu> that lists what
// folded; without one, the strip shows a ··· of its own.

interface Tool {
  priority: number;
  /** Registration order: of equal priority, the later tool folds first. */
  seq: number;
  menu: () => readonly MenuEntry[];
}

/** The tools of one panel's toolbar, and how many of them are folded. */
export class ToolScope {
  private readonly tools = new Map<string, Tool>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  /** The toolbar width each fold needed to show its tool again, latest last. */
  private needs: number[] = [];
  /** Menus that list the folded tools; with none, the strip shows its own. */
  menus = 0;
  version = 0;

  get folded(): number {
    return this.needs.length;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  register(id: string, tool: Omit<Tool, "seq">): void {
    const known = this.tools.get(id);
    this.tools.set(id, { ...tool, seq: known?.seq ?? this.seq++ });
    if (!known || known.priority !== tool.priority) this.notify();
  }

  unregister(id: string): void {
    if (!this.tools.delete(id)) return;
    // Fewer tools than folds would leave unfolds with nothing to show.
    if (this.needs.length > this.tools.size)
      this.needs = this.needs.slice(0, this.tools.size);
    this.notify();
  }

  /** Tools in the order they fold. */
  private ranked(): string[] {
    return [...this.tools]
      .sort(([, a], [, b]) => a.priority - b.priority || b.seq - a.seq)
      .map(([id]) => id);
  }

  isFolded(id: string): boolean {
    return this.ranked().slice(0, this.folded).includes(id);
  }

  canFold(): boolean {
    return this.folded < this.tools.size;
  }

  /** Folds the next tool; it comes back once the toolbar is `need` wide. */
  fold(need: number): void {
    if (!this.canFold()) return;
    this.needs = [...this.needs, need];
    this.notify();
  }

  /** The width the last fold needs before its tool shows again. */
  nextNeed(): number {
    return this.needs.at(-1) ?? 0;
  }

  unfold(): void {
    if (!this.needs.length) return;
    this.needs = this.needs.slice(0, -1);
    this.notify();
  }

  /** The folded tools' entries, in toolbar order, each tool's apart. */
  menu(): MenuEntry[] {
    const folded = new Set(this.ranked().slice(0, this.folded));
    const groups = [...this.tools]
      .filter(([id]) => folded.has(id))
      .sort(([, a], [, b]) => a.seq - b.seq)
      .map(([, tool]) => tool.menu());
    return groups
      .filter((group) => group.length)
      .flatMap((group, index) =>
        index ? ["separator" as const, ...group] : [...group],
      );
  }
}

const scopes = new WeakMap<Element, ToolScope>();

/** The scope of the toolbar `element` holds. */
export function toolScopeOf(element: Element): ToolScope {
  let scope = scopes.get(element);
  if (!scope) {
    scope = new ToolScope();
    scopes.set(element, scope);
  }
  return scope;
}

/**
 * The node a panel's toolbar keeps while it moves between areas: a view from
 * outside the layout keeps its toolbar node, and the layout's own panels
 * portal into their area's slot.
 */
export const TOOLBAR_SCOPE = ".dock-view-toolbar, .dock-toolbar";

const ScopeContext = createContext<ToolScope | null>(null);

/** Lets the tools in `children` fold into the toolbar that holds `from`. */
export function PanelTools({
  from,
  children,
}: {
  from: Element | null;
  children: ReactNode;
}) {
  const element = from?.closest(TOOLBAR_SCOPE);
  const scope = element ? toolScopeOf(element) : null;
  return (
    <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
  );
}

/**
 * A tool that folds into the menu when its toolbar runs out of room. Higher
 * `priority` stays longer. `menu` is what it becomes there: a segmented
 * control's choices as radio items, a button as one item.
 */
export function PanelTool({
  id,
  priority = 0,
  menu,
  children,
}: {
  id: string;
  priority?: number;
  menu: readonly MenuEntry[];
  children?: ReactNode;
}) {
  const scope = useContext(ScopeContext);
  const latest = useRef(menu);
  latest.current = menu;
  useLayoutEffect(() => {
    if (!scope) return;
    scope.register(id, { priority, menu: () => latest.current });
  }, [scope, id, priority]);
  useLayoutEffect(() => {
    if (!scope) return;
    return () => scope.unregister(id);
  }, [scope, id]);
  const folded = useSyncExternalStore(
    scope?.subscribe ?? noSubscription,
    () => scope?.isFolded(id) ?? false,
    () => false,
  );
  // A folded tool's entries change with it, a choice's check for one: the
  // menu showing them reads them again.
  const shown = useRef("");
  useLayoutEffect(() => {
    const signature = folded ? menuSignature(menu) : "";
    if (signature === shown.current) return;
    shown.current = signature;
    if (folded) scope?.notify();
  });
  return folded ? null : <>{children}</>;
}

function menuSignature(entries: readonly MenuEntry[]): string {
  return JSON.stringify(
    entries.map((entry) =>
      typeof entry === "string" || "heading" in entry
        ? entry
        : [
            typeof entry.label === "string" ? entry.label : "",
            entry.checked,
            entry.disabled,
          ],
    ),
  );
}

/**
 * The panel's own ··· menu: `items` after the tools that folded into it.
 * While a panel has one, the strip doesn't add a ··· of its own.
 */
export function PanelToolsMenu({
  items,
  ...props
}: Parameters<typeof DropdownMenu>[0]) {
  const scope = useContext(ScopeContext);
  useLayoutEffect(() => {
    if (!scope) return;
    scope.menus += 1;
    scope.notify();
    return () => {
      scope.menus -= 1;
      scope.notify();
    };
  }, [scope]);
  useSyncExternalStore(
    scope?.subscribe ?? noSubscription,
    () => scope?.version ?? 0,
    () => 0,
  );
  const folded = scope?.menu() ?? [];
  return (
    <DropdownMenu
      {...props}
      items={folded.length ? [...folded, "separator", ...items] : items}
    />
  );
}

const noSubscription = () => () => {};
