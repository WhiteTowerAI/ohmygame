// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ExampleSummary } from "../src/shared/examples.js";

const examples: ExampleSummary[] = [
  ...["circuit", "tidal", "ember", "wetland", "garden"].map((id) => ({ id, type: "web-game" as const, name: id, description: "" })),
  { id: "last-bus", type: "interactive-story", name: "Last Bus", description: "" },
  ...["harbor", "orbit", "meadow"].map((id) => ({ id, type: "web-game" as const, name: id, description: "" })),
];

vi.doMock(path.resolve("src/renderer/runtime-connection.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/runtime-connection.js")>()),
  useReadyRuntimeGeneration: () => 1,
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listProjects: async () => [],
  listExamples: async () => examples,
  getExampleCover: async () => undefined,
  waitForRuntime: async () => undefined,
}));
vi.doMock(path.resolve("src/renderer/app-sidebar.tsx"), () => ({ AppSidebar: () => null }));
vi.doMock(path.resolve("src/renderer/project-prompt-creator.tsx"), () => ({ ProjectPromptCreator: () => null }));

const { Home } = await import("../src/renderer/home.js");
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

it("shows two rows of examples in Explore, so an example past the first row is there too", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Home onNavigate={() => {}} onCreate={async () => {}} onOpen={() => {}} />));

  const shown = [...container.querySelectorAll(".home-explore-card")].map((card) => card.textContent);
  // Four columns by default: eight cards, including Last Bus in sixth place.
  expect(shown).toHaveLength(8);
  expect(shown.some((text) => text?.includes("Last Bus"))).toBe(true);
  expect(shown.some((text) => text?.includes("meadow"))).toBe(false);
});
