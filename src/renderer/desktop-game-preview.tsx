import { useEffect, useLayoutEffect, useRef, useState, type DependencyList, type RefObject } from "react";
import type { DesktopWebGamePreviewBridge, WebGamePlayerBridge, WebGamePreviewLayout } from "../shared/web-game-player.js";

/** How long a still taken as a menu was pressed can stand in for the game. */
const STILL_REUSE_MS = 1500;
/** How long the view waits for its still before it hides anyway. */
const STILL_WAIT_MS = 500;

/** Native views sit above DOM content, so clip them and hide them beneath overlays. */
export function desktopPreviewLayout(element: HTMLElement, visible: boolean): WebGamePreviewLayout {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  visible = visible && element.isConnected && right > left && bottom > top;
  if (visible) {
    for (const overlay of document.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"], [role="alert"], [data-native-preview-overlay]')) {
      const bounds = overlay.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0 || getComputedStyle(overlay).visibility === "hidden") continue;
      if (overlay.getAttribute("aria-modal") === "true" || (bounds.left < right && bounds.right > left && bounds.top < bottom && bounds.bottom > top)) {
        visible = false;
        break;
      }
    }
  }
  return { bounds: { x: Math.max(0, left), y: Math.max(0, top), width: Math.max(0, right - left), height: Math.max(0, bottom - top) }, visible };
}

/** The native view a panel places over itself, with what it is asked to do. */
export interface NativeViewHandle {
  /** Whether the panel wants the view shown now, before menus and clipping are taken into account. */
  wanted(): boolean;
  /** The view's current frame as JPEG. */
  capture(): Promise<Uint8Array>;
  layout(layout: WebGamePreviewLayout): Promise<void>;
  detach(): Promise<void>;
}

/**
 * Keeps a native view over `element`: clipped to what scrolls it, hidden
 * beneath menus and dialogs with a still standing in, and detached when the
 * dependencies change or the panel goes. `synchronize` lays it out again now.
 */
export function useNativeViewPlacement(element: RefObject<HTMLElement | null>, handle: NativeViewHandle, dependencies: DependencyList): { still: string | undefined; synchronize: RefObject<() => void> } {
  const [still, setStill] = useState<string>();
  const view = useRef(handle);
  view.current = handle;
  const synchronize = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    // Cleanup belongs to this attachment, even after a render switches projects.
    const detach = view.current.detach;
    let animation = 0;
    let last = "";
    let shown = false;
    // The native view can only hide whole, so when a menu or dialog covers
    // it, a still of the game stands in instead of an empty panel. The still
    // is taken as the person presses whatever opens the menu, so it is ready
    // when the menu appears, and the view hides once the still has painted.
    let early: { at: number; still: Promise<string | undefined> } | undefined;
    let disposed = false;
    const discard = (still: Promise<string | undefined>) => { void still.then((url) => { if (url) URL.revokeObjectURL(url); }); };
    const takeStill = async () => {
      const jpeg = await view.current.capture().catch(() => undefined);
      if (!jpeg?.length) return undefined;
      const url = URL.createObjectURL(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
      const image = new Image();
      image.src = url;
      await image.decode?.().catch(() => {});
      return url;
    };
    const prepare = (event: Event) => {
      // Only a control can open a menu or dialog; typing never needs a still.
      if (!shown || !(event.target instanceof Element) || element.current?.contains(event.target)) return;
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
      const control = event.target.closest('button, [role="button"], [role="menuitem"], [role="combobox"]');
      if (!control) return;
      // Switching or closing a tab hides or keeps the game; only a tab strip's menus cover it.
      if (control.closest('[role="tablist"]') && !control.hasAttribute("aria-haspopup")) return;
      if (early) discard(early.still);
      early = { at: performance.now(), still: takeStill() };
    };
    const update = () => {
      if (!element.current) return;
      const layout = desktopPreviewLayout(element.current, view.current.wanted());
      const serialized = JSON.stringify(layout);
      if (serialized === last) return;
      last = serialized;
      const send = () => { if (last === serialized) void view.current.layout(layout).catch(() => {}); };
      const covered = shown && !layout.visible && view.current.wanted();
      shown = layout.visible;
      if (layout.visible) setStill(undefined);
      if (!covered) return send();
      const fresh = early && performance.now() - early.at < STILL_REUSE_MS;
      if (early && !fresh) discard(early.still);
      const pending = fresh ? early!.still : takeStill();
      early = undefined;
      // Hide the view once the still is on screen, a frame after it renders.
      const hide = () => requestAnimationFrame(() => requestAnimationFrame(send));
      let late = false;
      const timer = setTimeout(() => { late = true; hide(); }, STILL_WAIT_MS);
      void pending.then((url) => {
        if (late || disposed || last !== serialized) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        clearTimeout(timer);
        if (url) setStill(url);
        hide();
      });
    };
    const schedule = () => {
      if (animation) return;
      animation = requestAnimationFrame(() => { animation = 0; update(); });
    };
    synchronize.current = update;
    const resize = new ResizeObserver(schedule);
    for (let parent: Element | null = element.current; parent; parent = parent.parentElement) resize.observe(parent);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden", "aria-hidden", "aria-modal"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("pointerdown", prepare, true);
    document.addEventListener("keydown", prepare, true);
    update();
    return () => {
      disposed = true;
      if (early) discard(early.still);
      cancelAnimationFrame(animation);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("pointerdown", prepare, true);
      document.removeEventListener("keydown", prepare, true);
      synchronize.current = () => {};
      void detach().catch(() => {});
    };
  }, dependencies);

  useEffect(() => () => { if (still) URL.revokeObjectURL(still); }, [still]);
  return { still, synchronize };
}

export function DesktopGamePreview({ bridge, refresh, projectId, url, reload, visible, onReady }: {
  bridge: DesktopWebGamePreviewBridge; projectId: string; url: string;
  refresh: WebGamePlayerBridge["refresh"];
  reload: number; visible: boolean; onReady: (element: HTMLElement) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [attachment] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const state = useRef({ visible, error, onReady });
  state.current = { visible, error, onReady };
  const previousReload = useRef(reload);
  const { still, synchronize } = useNativeViewPlacement(element, {
    wanted: () => state.current.visible && !state.current.error,
    capture: () => bridge.capture(projectId),
    layout: (layout) => bridge.layout(projectId, attachment, layout),
    detach: () => bridge.detach(projectId, attachment),
  }, [bridge, projectId, attachment]);

  useLayoutEffect(() => {
    if (!element.current) return;
    let disposed = false;
    setError(undefined);
    const layout = desktopPreviewLayout(element.current, state.current.visible);
    // Share attachment/retry handling, and cancel callbacks from older URLs or mounts.
    void bridge.attach(projectId, attachment, url, layout).then(async () => {
      if (disposed) return;
      if (previousReload.current !== reload) {
        previousReload.current = reload;
        await refresh(projectId, true);
      }
      if (!disposed && element.current) {
        synchronize.current();
        state.current.onReady(element.current);
      }
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [bridge, refresh, projectId, attachment, url, reload]);

  useLayoutEffect(() => { synchronize.current(); }, [visible, error]);

  return <div ref={element} className="preview-frame" data-native-game-preview={projectId}>
    {still && !error ? <img className="preview-frame-still" src={still} alt="" /> : null}
    {error ? <div className="preview-status-panel" role="alert">{error}</div> : null}
  </div>;
}
