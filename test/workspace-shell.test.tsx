// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAgentPane, WorkspaceShell } from "../src/renderer/workspace-shell.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, right: 1200, width: 1200, top: 0, bottom: 800, height: 800, x: 0, y: 0, toJSON() {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(layout: "left" | "right", collapsed = false) {
  await act(async () => root.render(<WorkspaceShell chatLayout={layout} agentCollapsed={collapsed}
    onHome={() => {}} onExpandAgent={() => {}}
    agent={<WorkspaceAgentPane actions={null}><input aria-label="Draft" defaultValue="Saved draft" /></WorkspaceAgentPane>}>
    <section className="viewer-pane">Preview</section>
  </WorkspaceShell>));
}
const shell = () => container.querySelector<HTMLElement>("main")!;
const separator = () => container.querySelector<HTMLElement>('[role="separator"]')!;

describe("shared workspace layout", () => {
  it.each(["left", "right"] as const)("resizes %s chat in the arrow's physical direction and restores its width in another workspace", async layout => {
    await render(layout);
    await act(async () => separator().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    const width = layout === "left" ? 446 : 414;
    expect(separator().getAttribute("aria-valuenow")).toBe(String(width));
    expect(shell().style.getPropertyValue("--agent-width")).toBe(`${width}px`);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(layout);
    expect(separator().getAttribute("aria-valuenow")).toBe(String(width));
    await act(async () => separator().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(separator().getAttribute("aria-valuenow")).toBe("430");
  });

  it("clamps pointer drags, saves on release, and removes the resize shield", async () => {
    await render("left");
    const handle = separator();
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = vi.fn();
    await act(async () => handle.dispatchEvent(new PointerEvent("pointerdown", { isPrimary: true, button: 0, pointerId: 1, bubbles: true })));
    expect(container.querySelector(".workspace-resize-shield")).not.toBeNull();
    await act(async () => handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 1100, pointerId: 1, bubbles: true })));
    await act(async () => handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true })));
    expect(handle.getAttribute("aria-valuenow")).toBe("780");
    expect(localStorage.getItem("ohmygame-agent-width")).toBe("780");
    expect(container.querySelector(".workspace-resize-shield")).toBeNull();
    await act(async () => handle.dispatchEvent(new PointerEvent("pointerdown", { isPrimary: true, button: 0, pointerId: 2, bubbles: true })));
    await act(async () => handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 0, pointerId: 2, bubbles: true })));
    await act(async () => handle.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 2, bubbles: true })));
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
  });

  it("retains the chat's draft across collapse and removes the hidden splitter from keyboard navigation", async () => {
    await render("left");
    const input = container.querySelector<HTMLInputElement>("input")!;
    input.value = "Unsent changes";
    await render("left", true);
    expect(separator().tabIndex).toBe(-1);
    expect(separator().getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[aria-label="Show agent"]')).not.toBeNull();
    await render("left");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Unsent changes");
    expect(separator().tabIndex).toBe(0);
  });
});
