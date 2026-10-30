import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

export function DesktopGamePreview({ bridge, refresh, projectId, url, reload, visible, onReady }: {
  bridge: DesktopWebGamePreviewBridge; projectId: string; url: string;
  refresh: WebGamePlayerBridge["refresh"];
  reload: number; visible: boolean; onReady: (element: HTMLElement) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [attachment] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const [still, setStill] = useState<string>();
  const state = useRef({ visible, error, onReady });
  state.current = { visible, error, onReady };
  const synchronize = useRef<() => void>(() => {});
  const previousReload = useRef(reload);

  useLayoutEffect(() => {
    let animation = 0;
    let last = "";
    let shown = false;
    // The native view can only hide whole, so when a menu or dialog covers
    // it, a still of the game stands in instead of an empty panel. The still
    // is taken as the person presses whatever opens the menu, so it is ready
    // when the menu appears, and the view hides once the still has painted.
    let early: { at: number; still: Promise<string | undefined> } | undefined;
    const takeStill = async () => {
      const png = await bridge.capture(projectId).catch(() => undefined);
      if (!png?.length) return undefined;
      const url = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
      const image = new Image();
      image.src = url;
      await image.decode?.().catch(() => {});
      return url;
    };
    const prepare = (event: Event) => {
      // Only a control can open a menu or dialog; typing never needs a still.
      if (!shown || !(event.target instanceof Element) || element.current?.contains(event.target)) return;
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
      if (!event.target.closest('button, [role="button"], [role="menuitem"], [role="combobox"]')) return;
      early = { at: performance.now(), still: takeStill() };
    };
    const update = () => {
      if (!element.current) return;
      const layout = desktopPreviewLayout(element.current, state.current.visible && !state.current.error);
      const serialized = JSON.stringify(layout);
      if (serialized === last) return;
      last = serialized;
      const send = () => { if (last === serialized) void bridge.layout(projectId, attachment, layout).catch(() => {}); };
      const covered = shown && !layout.visible && state.current.visible && !state.current.error;
      shown = layout.visible;
      if (layout.visible) setStill(undefined);
      if (!covered) return send();
      const pending = early && performance.now() - early.at < STILL_REUSE_MS ? early.still : takeStill();
      early = undefined;
      void Promise.race([pending, new Promise<undefined>((resolve) => setTimeout(resolve, STILL_WAIT_MS))])
        .then((url) => {
          if (url && last === serialized) setStill(url);
          else if (url) URL.revokeObjectURL(url);
          // Hide the view once the still is on screen, a frame after it renders.
          requestAnimationFrame(() => requestAnimationFrame(send));
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
      cancelAnimationFrame(animation);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("pointerdown", prepare, true);
      document.removeEventListener("keydown", prepare, true);
      synchronize.current = () => {};
      void bridge.detach(projectId, attachment).catch(() => {});
    };
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
  useEffect(() => () => { if (still) URL.revokeObjectURL(still); }, [still]);

  return <div ref={element} className="preview-frame" data-native-game-preview={projectId}>
    {still && !error ? <img className="preview-frame-still" src={still} alt="" /> : null}
    {error ? <div className="preview-status-panel" role="alert">{error}</div> : null}
  </div>;
}
