// @vitest-environment happy-dom
import { act, type Ref } from "react";
import { createRoot } from "react-dom/client";
import type { Edge, Node, ReactFlowProps } from "@xyflow/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorCanvas } from "../src/renderer/editor-canvas.js";

const flow = vi.hoisted(() => ({
  props: undefined as ReactFlowProps<Node, Edge> | undefined,
  initialized: false,
  deleteElements: vi.fn(async () => ({ deletedNodes: [], deletedEdges: [] })),
  fitView: vi.fn<() => Promise<boolean>>(),
  getViewport: vi.fn(() => ({ x: 80, y: 40, zoom: 0.4 })),
}));

vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: ReactFlowProps<Node, Edge> & { ref?: Ref<HTMLDivElement> }) => {
    flow.props = props;
    return (
      <div data-testid="canvas" className="react-flow" ref={props.ref} style={props.style}>
        {props.children}
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
  useReactFlow: () => ({
    fitView: flow.fitView,
    getViewport: flow.getViewport,
    deleteElements: flow.deleteElements,
  }),
  useStoreApi: () => ({
    getState: () => ({ nodes: [{ id: "selected", selected: true }], edges: [] }),
    setState: () => {},
  }),
}));

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
  flow.deleteElements.mockClear();
  const page = (assetsHidden: boolean) => (
    <>
      <EditorCanvas nodes={nodes} addControl={null} onOpenMenu={vi.fn()} deleteKeyCode={["Delete"]} />
      <div hidden={assetsHidden}>
        <EditorCanvas nodes={nodes} addControl={null} onOpenMenu={vi.fn()} deleteKeyCode={["Delete"]} />
      </div>
      <button type="button">Elsewhere</button>
    </>
  );
  await act(async () => root.render(page(false)));
  // React Flow's own delete keys are off; the editor decides which canvas deletes.
  expect(flow.props!.deleteKeyCode).toBeNull();
  const [, assets] = container.querySelectorAll<HTMLElement>('[data-testid="canvas"]');
  const press = async (target: Element) => {
    await act(async () => { target.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
  };
  await press(assets!);
  expect(flow.deleteElements).toHaveBeenCalledOnce();
  expect(flow.deleteElements).toHaveBeenCalledWith({ nodes: [{ id: "selected", selected: true }], edges: [] });
  // A click outside every canvas leaves the keys where they were.
  await press(container.querySelector("button")!);
  expect(flow.deleteElements).toHaveBeenCalledTimes(2);
  // With the canvas used last hidden, the one in sight takes them.
  await act(async () => root.render(page(true)));
  await press(container.querySelector("button")!);
  expect(flow.deleteElements).toHaveBeenCalledTimes(3);
  // Typing in a field deletes nothing.
  const field = document.createElement("input");
  container.append(field);
  await press(field);
  expect(flow.deleteElements).toHaveBeenCalledTimes(3);
});
