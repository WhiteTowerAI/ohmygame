// @vitest-environment happy-dom
import { act, type Ref } from "react";
import { createRoot } from "react-dom/client";
import type { Edge, Node, ReactFlowProps } from "@xyflow/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorCanvas } from "../src/renderer/editor-canvas.js";

const flow = vi.hoisted(() => ({
  props: undefined as ReactFlowProps<Node, Edge> | undefined,
  initialized: false,
  /** Which canvas deleted its selection, by its id. */
  deleted: [] as string[],
  fitView: vi.fn<() => Promise<boolean>>(),
  getViewport: vi.fn(() => ({ x: 80, y: 40, zoom: 0.4 })),
}));

vi.mock("@xyflow/react", async () => {
  const { createContext, useContext } = await import("react");
  // Each canvas's hooks answer for that canvas.
  const CanvasId = createContext("");
  return {
  ReactFlow: (props: ReactFlowProps<Node, Edge> & { ref?: Ref<HTMLDivElement> }) => {
    flow.props = props;
    return (
      <div data-testid="canvas" className="react-flow" ref={props.ref} style={props.style}>
        <CanvasId.Provider value={props.id ?? ""}>{props.children}</CanvasId.Provider>
      </div>
    );
  },
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  Panel: () => null,
  ViewportPortal: () => null,
  useNodesInitialized: () => flow.initialized,
  useStore: (selector: (state: object) => unknown) =>
    selector({ width: 1000, height: 700, transform: [0, 0, 1] }),
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useReactFlow: () => {
    const id = useContext(CanvasId);
    return {
      fitView: flow.fitView,
      getViewport: flow.getViewport,
      deleteElements: async () => { flow.deleted.push(id); return { deletedNodes: [], deletedEdges: [] }; },
    };
  },
  useStoreApi: () => ({
    getState: () => ({ nodes: [{ id: "selected", selected: true }], edges: [] }),
    setState: () => {},
  }),
  };
});

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  flow.initialized = false;
  flow.fitView.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const nodes = [{ id: "document", position: { x: 0, y: 0 }, data: {} }];
const canvas = () =>
  container.querySelector<HTMLElement>('[data-testid="canvas"]')!;
async function render(
  fitViewOnLoad = false,
  items: Node[] = nodes,
  onInitialFit = vi.fn(),
) {
  await act(async () =>
    root.render(
      <EditorCanvas
        nodes={items}
        addControl={null}
        onOpenMenu={vi.fn()}
        defaultViewport={{ x: 80, y: 40, zoom: 0.4 }}
        fitViewOnLoad={fitViewOnLoad}
        onInitialFit={onInitialFit}
        style={{ background: "red" }}
      />,
    ),
  );
}
async function initialize() {
  await act(async () => flow.props!.onInit!({} as never));
}

it("does not expose the initial 100% view before the saved viewport is initialized, including on remount", async () => {
  for (let index = 0; index < 2; index++) {
    await render();
    expect(canvas().style.opacity).toBe("0");
    expect(canvas().style.pointerEvents).toBe("none");
    expect(canvas().style.background).toBe("red");
    await initialize();
    expect(canvas().style.opacity).toBe("");
    expect(canvas().style.pointerEvents).toBe("");
    await act(async () => root.render(null));
  }
});

it("waits for node measurements and the fitted viewport before revealing a remix", async () => {
  let finishFit!: (fitted: boolean) => void;
  flow.fitView.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishFit = resolve;
      }),
  );
  const onInitialFit = vi.fn();
  await render(true, nodes, onInitialFit);
  await initialize();
  expect(canvas().style.opacity).toBe("0");
  expect(flow.fitView).not.toHaveBeenCalled();
  flow.initialized = true;
  await render(true, nodes, onInitialFit);
  expect(flow.fitView).toHaveBeenCalledOnce();
  expect(canvas().style.opacity).toBe("0");
  await act(async () => finishFit(true));
  expect(canvas().style.opacity).toBe("");
  expect(onInitialFit).toHaveBeenCalledWith({ x: 80, y: 40, zoom: 0.4 });
});

it("reveals empty boards and boards with only hidden nodes without waiting for a fit", async () => {
  for (const items of [[], nodes.map((node) => ({ ...node, hidden: true }))]) {
    await render(true, items);
    await initialize();
    expect(canvas().style.opacity).toBe("");
    expect(flow.fitView).not.toHaveBeenCalled();
    await act(async () => root.render(null));
  }
});

it("deletes only in the canvas used last while it is in sight, when canvases share the page", async () => {
  flow.deleted = [];
  const page = (assetsHidden: boolean) => (
    <>
      <div className="story-panel">
        <EditorCanvas id="story" nodes={nodes} addControl={null} onOpenMenu={vi.fn()} deleteKeyCode={["Delete"]} />
      </div>
      <div hidden={assetsHidden}>
        <div className="interactive-story-canvas" tabIndex={0}>
          <EditorCanvas id="assets" nodes={nodes} addControl={null} onOpenMenu={vi.fn()} deleteKeyCode={["Delete"]} />
        </div>
      </div>
      <button type="button">Elsewhere</button>
    </>
  );
  await act(async () => root.render(page(false)));
  // React Flow's own delete keys are off; the editor decides which canvas deletes.
  expect(flow.props!.deleteKeyCode).toBeNull();
  const canvasOf = (id: string) => [...container.querySelectorAll<HTMLElement>('[data-testid="canvas"]')][id === "story" ? 0 : 1]!;
  const key = (target: Element) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
  const press = async (target: Element) => {
    await act(async () => { target.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await key(target);
  };
  await press(canvasOf("assets"));
  expect(flow.deleted).toEqual(["assets"]);
  // A click outside every canvas leaves the keys where they were.
  await press(container.querySelector("button")!);
  expect(flow.deleted).toEqual(["assets", "assets"]);
  // With the canvas used last hidden, the one in sight takes them.
  await act(async () => root.render(page(true)));
  await press(container.querySelector("button")!);
  expect(flow.deleted).toEqual(["assets", "assets", "story"]);
  // Focus on an element around one canvas, as from the keyboard, hands it the keys.
  await act(async () => root.render(page(false)));
  flow.deleted = [];
  await press(canvasOf("story"));
  await act(async () => container.querySelector<HTMLElement>(".interactive-story-canvas")!.focus());
  await key(canvasOf("story"));
  expect(flow.deleted).toEqual(["story", "assets"]);
  // Any other element around one canvas, such as its panel, is not that canvas.
  await press(container.querySelector(".story-panel")!);
  expect(flow.deleted).toEqual(["story", "assets", "assets"]);
  // Typing in a field deletes nothing.
  const field = document.createElement("input");
  container.append(field);
  await press(field);
  expect(flow.deleted).toEqual(["story", "assets", "assets"]);
});
