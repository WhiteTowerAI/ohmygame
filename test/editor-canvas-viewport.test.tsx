// @vitest-environment happy-dom
import { act, type Ref } from "react";
import { createRoot } from "react-dom/client";
import type { Edge, Node, ReactFlowProps } from "@xyflow/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorCanvas } from "../src/renderer/editor-canvas.js";

const flow = vi.hoisted(() => ({
  props: undefined as ReactFlowProps<Node, Edge> | undefined,
  /** The props of each canvas on the page, by its id. */
  byId: {} as Record<string, ReactFlowProps<Node, Edge>>,
  initialized: false,
  fitView: vi.fn<() => Promise<boolean>>(),
  getViewport: vi.fn(() => ({ x: 80, y: 40, zoom: 0.4 })),
}));

vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: ReactFlowProps<Node, Edge> & { ref?: Ref<HTMLDivElement> }) => {
    flow.props = props;
    if (props.id) flow.byId[props.id] = props;
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

it("gives delete keys to the canvas used last when canvases share the page", async () => {
  await act(async () =>
    root.render(
      <>
        {["story", "assets"].map((id) => (
          <EditorCanvas key={id} id={id} nodes={nodes} addControl={null} onOpenMenu={vi.fn()} deleteKeyCode={["Delete"]} />
        ))}
        <button type="button">Elsewhere</button>
      </>,
    ),
  );
  const [story, assets] = container.querySelectorAll<HTMLElement>('[data-testid="canvas"]');
  const press = (target: Element) => act(async () => { target.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  const keys = () => [flow.byId.story!.deleteKeyCode, flow.byId.assets!.deleteKeyCode];
  expect(keys()).toEqual([["Delete"], ["Delete"]]);
  await press(assets!);
  expect(keys()).toEqual([null, ["Delete"]]);
  // A click outside every canvas changes nothing.
  await press(container.querySelector("button")!);
  expect(keys()).toEqual([null, ["Delete"]]);
  await press(story!);
  expect(keys()).toEqual([["Delete"], null]);
});
