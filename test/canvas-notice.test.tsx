// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasNotice } from "../src/renderer/canvas-notice.js";

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("keeps a dismissed recurring error hidden and shows a different error", async () => {
  await act(async () => root.render(<CanvasNotice message="Save failed" detail="Offline" />));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss notice"]')!.click());
  await act(async () => root.render(<CanvasNotice message="Save failed" detail="Offline" />));
  expect(container.textContent).toBe("");
  await act(async () => root.render(<CanvasNotice message="Import failed" />));
  expect(container.textContent).toContain("Import failed");
});
it("shows pending feedback, prevents duplicate retries, and exposes retry failures in Details", async () => {
  let reject!: (error: Error) => void;
  const retry = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no; }));
  await act(async () => root.render(<CanvasNotice message="Could not save" actionLabel="Retry save" onAction={retry} />));
  const button = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => { button.click(); button.click(); });
  expect(retry).toHaveBeenCalledOnce();
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("Retrying");
  await act(async () => reject(new Error("The disk is unavailable")));
  expect(button.disabled).toBe(false);
  expect(container.textContent).toContain("Retry failed");
  expect(container.querySelector("details")!.textContent).toContain("The disk is unavailable");
});
