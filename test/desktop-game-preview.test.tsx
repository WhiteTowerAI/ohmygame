// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopGamePreview, desktopPreviewLayout } from "../src/renderer/desktop-game-preview.js";

const roots: ReturnType<typeof createRoot>[] = [];

function bounds(element: Element, x: number, y: number, width: number, height: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });
}
function stage() {
  const parent = document.createElement("div");
  const frame = document.createElement("div");
  parent.append(frame);
  document.body.append(parent);
  bounds(frame, 300, 100, 600, 500);
  return { parent, frame };
}
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native preview placement", () => {
  it("clips the game to scrollable ancestors and the renderer viewport", () => {
    const { parent, frame } = stage();
    parent.style.overflowX = "hidden";
    parent.style.overflowY = "auto";
    bounds(parent, 350, 120, 400, 300);
    expect(desktopPreviewLayout(frame, true)).toEqual({ bounds: { x: 350, y: 120, width: 400, height: 300 }, visible: true });
  });
  it.each(["dialog", "alertdialog"])("hides the native view under a modal %s and restores it when closed", (role) => {
    const { frame } = stage();
    const dialog = document.createElement("section");
    dialog.setAttribute("role", role);
    dialog.setAttribute("aria-modal", "true");
    bounds(dialog, 10, 10, 100, 100);
    document.body.append(dialog);
    expect(desktopPreviewLayout(frame, true).visible).toBe(false);
    dialog.remove();
    expect(desktopPreviewLayout(frame, true).visible).toBe(true);
  });
  it("hides for overlapping menus and diagnostics while leaving unrelated popups alone", () => {
    const { frame } = stage();
    const menu = document.createElement("section");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    bounds(menu, 10, 10, 100, 100);
    expect(desktopPreviewLayout(frame, true).visible).toBe(true);
    bounds(menu, 400, 200, 100, 100);
    expect(desktopPreviewLayout(frame, true).visible).toBe(false);
    menu.style.visibility = "hidden";
    expect(desktopPreviewLayout(frame, true).visible).toBe(true);
    expect(desktopPreviewLayout(frame, false).visible).toBe(false);
  });
});

describe("native preview loading", () => {
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

  function mount() {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const bridge = {
      attach: vi.fn(async () => {}), layout: vi.fn(async () => {}),
      detach: vi.fn(async () => {}), capture: vi.fn(async () => new Uint8Array()),
    };
    const refresh = vi.fn(async () => {});
    const onReady = vi.fn();
    const render = (reload = 0, url = "http://127.0.0.1:4000/") => act(async () => {
      root.render(<DesktopGamePreview bridge={bridge} refresh={refresh} projectId="game" url={url} reload={reload} visible onReady={onReady} />);
    });
    return { container, root, bridge, refresh, onReady, render };
  }

  it("cancels a pending refresh attachment when the component unmounts", async () => {
    const { root, bridge, refresh, onReady, render } = mount();
    await render();
    let finish!: () => void;
    bridge.attach.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render(1);
    await act(async () => root.unmount());
    await act(async () => finish());
    expect(refresh).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledOnce();
    expect(bridge.detach).toHaveBeenCalledOnce();
  });

  it("carries a refresh over a URL change without attaching twice or applying stale callbacks", async () => {
    const { bridge, refresh, onReady, render } = mount();
    await render();
    bridge.attach.mockClear();
    let finish!: () => void;
    bridge.attach.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render(1);
    expect(bridge.attach).toHaveBeenCalledOnce();
    await render(1, "http://127.0.0.1:4000/scene");
    await act(async () => finish());
    expect(bridge.attach).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledExactlyOnceWith("game", true);
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it("retries a failed initial attachment from Refresh and clears the error", async () => {
    const { container, bridge, refresh, onReady, render } = mount();
    bridge.attach.mockRejectedValueOnce(new Error("Preview is unavailable"));
    await render();
    expect(container.textContent).toContain("Preview is unavailable");
    await render(1);
    expect(refresh).toHaveBeenCalledExactlyOnceWith("game", true);
    expect(onReady).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Preview is unavailable");
  });
});
