// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectActivitySnapshot } from "../src/shared/contracts.js";

let emit: (snapshot: ProjectActivitySnapshot) => void = () => {};
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  streamProjectActivity: async (_signal: AbortSignal, onSnapshot: typeof emit) => { emit = onSnapshot; },
}));
const { useRunAlerts } = await import("../src/renderer/run-alerts.js");

const shown: string[] = [];
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  shown.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", Object.assign(function (this: object, title: string) { shown.push(title); }, { permission: "granted" }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  function Alerts() { useRunAlerts(() => {}); return null; }
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Alerts />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const names: ProjectActivitySnapshot["names"] = [{ id: "rocket", name: "Rocket", nameSource: "manual" }];
async function finish() {
  await act(async () => emit({ activity: [{ projectId: "rocket", status: "running" }], names }));
  await act(async () => emit({ activity: [], names }));
}

it("notifies when the project that finished is not on screen, even with the window in front", async () => {
  window.location.hash = "#/";
  await finish();
  expect(shown).toEqual(["Rocket"]);

  // Its chat already shows that it finished.
  window.location.hash = "#/projects/rocket";
  await finish();
  expect(shown).toEqual(["Rocket"]);
});
