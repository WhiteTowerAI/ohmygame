// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const get = vi.fn(async () => ({ mode: "sse" }));
const update = vi.fn();
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  getResponsesTransport: get,
  updateResponsesTransport: update,
}));
const { ProviderResponsesTransport } =
  await import("../src/renderer/responses-transport-settings.js");
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows the saved choice and preserves it when saving a new transport fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<ProviderResponsesTransport providerId="relay" />),
  );
  const select = host.querySelector("select")!;
  expect(get).toHaveBeenCalledWith("relay");
  expect(select.value).toBe("sse");
  update.mockRejectedValueOnce(new Error("Could not save transport"));
  await act(async () => {
    select.value = "websocket";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(update).toHaveBeenCalledWith("relay", "websocket");
  expect(select.value).toBe("sse");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not save transport",
  );
  update.mockResolvedValueOnce({ mode: "websocket" });
  await act(async () => {
    select.value = "websocket";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(select.value).toBe("websocket");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
