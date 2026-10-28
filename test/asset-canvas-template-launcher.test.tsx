// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetCanvasTemplateLauncher } from "../src/renderer/asset-canvas-template-launcher.js";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onOpenProject = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onOpenProject.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<AssetCanvasTemplateLauncher onOpenProject={onOpenProject} />),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Asset Canvas template launcher", () => {
  it("shows five templates and the effect library without an external form", () => {
    expect(container.querySelectorAll(".home-explore-card")).toHaveLength(6);
    expect(
      container.querySelectorAll(
        ".asset-template-cover > .asset-template-demo",
      ),
    ).toHaveLength(5);
    expect(
      [...container.querySelectorAll(".asset-template-cover")].map(
        (cover) => cover.querySelectorAll("img").length,
      ),
    ).toEqual([10, 1, 1, 2, 6]);
    expect(container.querySelector("form")).toBeNull();
  });

});
