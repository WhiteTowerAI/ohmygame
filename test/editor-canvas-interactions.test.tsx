// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  useNodesState,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorCanvas } from "../src/renderer/editor-canvas.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let flow: ReactFlowInstance;
const openMenu = vi.fn();
let initialized = false;
const instances = new Map<string, ReactFlowInstance>();
const activateNode = vi.fn();
const openNode = vi.fn();

function Canvas({ id = "primary" }: { id?: string }) {
  const [nodes, , onNodesChange] = useNodesState<Node>([
    {
      id: "a",
      position: { x: 180, y: 180 },
      width: 100,
      height: 100,
      data: {},
    },
    {
      id: "b",
      position: { x: 480, y: 180 },
      width: 100,
      height: 100,
      data: {},
    },
  ]);
  return (
    <div className="interactive-story-canvas" tabIndex={0}>
      <EditorCanvas
        id={id}
        nodes={nodes}
        edges={[]}
        onNodesChange={onNodesChange}
        addControl={null}
        onOpenMenu={openMenu}
        onNodeClick={activateNode}
        onNodeDoubleClick={openNode}
        onInit={(instance) => {
          flow = instance;
          instances.set(id, instance);
          initialized = true;
        }}
      />
    </div>
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Supply layout measurements; selection, node dragging and viewport events use
  // the real React Flow implementation rather than mocked callbacks or props.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("react-flow__node") ? 100 : 1000;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("react-flow__node") ? 100 : 700;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 700),
  );
  initialized = false;
  instances.clear();
  activateNode.mockClear();
  openNode.mockClear();
  openMenu.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Canvas />));
  await act(async () => {
    await expect.poll(() => initialized).toBe(true);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function pointer(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  button = 0,
) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button,
        buttons:
          type === "pointerup" ? 0 : button === 1 ? 4 : button === 2 ? 2 : 1,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
  });
}
const pane = () => container.querySelector<HTMLElement>(".react-flow__pane")!;

it("left-drags empty canvas to select nodes without moving the viewport", async () => {
  await marquee();
  expect(
    flow
      .getNodes()
      .filter((node) => node.selected)
      .map((node) => node.id),
  ).toEqual(["a", "b"]);
  expect(flow.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 });
  expect(
    container.querySelector(".react-flow__nodesselection-rect"),
  ).not.toBeNull();
});

async function marquee() {
  await pointer(pane(), "pointerdown", 120, 120);
  await pointer(pane(), "pointermove", 650, 350);
  await pointer(pane(), "pointerup", 650, 350);
}
async function drag(target: Element, button = 0) {
  await pointer(target, "pointerdown", 200, 200, button);
  for (const [eventTarget, type, x, y] of [
    [target, "mousedown", 200, 200],
    [window, "mousemove", 220, 215],
    [window, "mousemove", 240, 230],
    [window, "mouseup", 240, 230],
  ] as const) {
    await act(async () => {
      eventTarget.dispatchEvent(
        new MouseEvent(type, {
          view: window,
          bubbles: true,
          cancelable: true,
          button,
          buttons:
            type === "mouseup" ? 0 : button === 1 ? 4 : button === 2 ? 2 : 1,
          clientX: x,
          clientY: y,
        }),
      );
    });
  }
  await pointer(target, "pointerup", 240, 230, button);
  // D3 suppresses the click immediately following a drag until the next task.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("Space-drags over a selected node to pan without moving or deselecting the group", async () => {
  await marquee();
  const positions = flow.getNodes().map((node) => node.position);
  const node = container.querySelector<HTMLElement>(
    '.react-flow__node[data-id="a"]',
  )!;
  const activateKey = vi.fn();
  node.addEventListener("keydown", activateKey);
  expect((await space(node)).defaultPrevented).toBe(true);
  expect(activateKey).not.toHaveBeenCalled();
  await drag(node);
  expect(flow.getViewport()).toEqual({ x: 40, y: 30, zoom: 1 });
  expect(flow.getNodes().map((node) => node.position)).toEqual(positions);
  expect(flow.getNodes().every((node) => node.selected)).toBe(true);
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: " ", code: "Space" }),
    );
  });
  const viewport = flow.getViewport();
  await drag(node);
  expect(flow.getNode("a")!.position).not.toEqual(positions[0]);
  expect(flow.getViewport()).toEqual(viewport);
});

it("middle-drags over a draggable node to pan while left-drag still moves the node", async () => {
  const node = container.querySelector<HTMLElement>(
    '.react-flow__node[data-id="a"]',
  )!;
  await drag(node, 1);
  expect(flow.getViewport()).toEqual({ x: 40, y: 30, zoom: 1 });
  expect(flow.getNode("a")!.position).toEqual({ x: 180, y: 180 });
  await drag(node);
  expect(flow.getNode("a")!.position).not.toEqual({ x: 180, y: 180 });
  expect(flow.getViewport()).toEqual({ x: 40, y: 30, zoom: 1 });
});

it("keeps right-drag out of panning and opens the pane context menu", async () => {
  await drag(pane(), 2);
  expect(flow.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 });
  await act(async () => {
    pane().dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 200,
        clientY: 200,
      }),
    );
  });
  expect(openMenu).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "pane" }),
  );
});

async function space(
  target: EventTarget,
  type = "keydown",
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent(type, {
    key: " ",
    code: "Space",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}
const firstNode = () =>
  container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]')!;
async function clickTool(label: string) {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
      .click(),
  );
}

it("uses the hand tool for left-drag and returns to selection after switching tools", async () => {
  await clickTool("Pan canvas");
  await act(async () => {
    firstNode().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    firstNode().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(activateNode).not.toHaveBeenCalled();
  expect(openNode).not.toHaveBeenCalled();
  await space(pane());
  await space(window, "keyup");
  await drag(pane());
  expect(flow.getViewport()).toEqual({ x: 40, y: 30, zoom: 1 });
  await clickTool("Select");
  await marquee();
  expect(flow.getNodes().every((node) => node.selected)).toBe(true);
  expect(flow.getViewport()).toEqual({ x: 40, y: 30, zoom: 1 });
});

it("leaves Space in node fields and controls available to their handlers", async () => {
  const node = firstNode();
  await pointer(node, "pointerdown", 200, 200);
  for (const markup of [
    "<input>",
    "<textarea></textarea>",
    "<select></select>",
    '<div contenteditable="true"><span></span></div>',
    "<button><span></span></button>",
    '<a href="#"><span></span></a>',
    "<video controls></video>",
    "<audio controls></audio>",
    '<div role="slider"></div>',
    '<div class="nokey"><span></span></div>',
  ]) {
    const host = document.createElement("div");
    host.innerHTML = markup;
    node.append(host);
    const control = host.querySelector("span") ?? host.firstElementChild!;
    const handleKey = vi.fn();
    control.addEventListener("keydown", handleKey);
    expect((await space(control)).defaultPrevented).toBe(false);
    expect(handleKey).toHaveBeenCalledOnce();
    host.remove();
  }
  for (const init of [
    { isComposing: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
  ]) {
    expect((await space(node, "keydown", init)).defaultPrevented).toBe(false);
    // Release modifiers so React Flow's own multi-select hooks do not carry them forward.
    await space(window, "keyup", init);
  }
  await drag(node);
  expect(flow.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 });
  expect(flow.getNode("a")!.position).not.toEqual({ x: 180, y: 180 });
});

it("restores node dragging after blur, control focus or a context menu while Space is held", async () => {
  const node = firstNode();
  const field = document.createElement("input");
  node.append(field);
  for (const reset of [
    () => {
      window.dispatchEvent(new Event("blur"));
    },
    () => {
      field.focus();
    },
    () => {
      window.dispatchEvent(new Event("contextmenu"));
    },
  ]) {
    field.blur();
    await pointer(node, "pointerdown", 200, 200);
    await space(node);
    const before = flow.getNode("a")!.position;
    await drag(node);
    expect(flow.getNode("a")!.position).toEqual(before);
    const viewport = flow.getViewport();
    await act(async () => reset());
    await drag(node);
    expect(flow.getNode("a")!.position).not.toEqual(before);
    expect(flow.getViewport()).toEqual(viewport);
  }
});

it("limits Space to the last visible canvas and leaves external controls and modal dialogs alone", async () => {
  await act(async () =>
    root.render(
      <>
        <Canvas key="first" id="first" />
        <Canvas key="second" id="second" />
      </>,
    ),
  );
  await act(async () => {
    await expect
      .poll(() => instances.has("first") && instances.has("second"))
      .toBe(true);
  });
  const panes = container.querySelectorAll<HTMLElement>(".react-flow__pane");
  await pointer(panes[1], "pointerdown", 100, 100);
  await pointer(panes[1], "pointerup", 100, 100);
  expect((await space(document.body)).defaultPrevented).toBe(true);
  await drag(panes[0]);
  await drag(panes[1]);
  expect(instances.get("first")!.getViewport()).toEqual({
    x: 0,
    y: 0,
    zoom: 1,
  });
  expect(instances.get("second")!.getViewport()).toEqual({
    x: 40,
    y: 30,
    zoom: 1,
  });
  await space(window, "keyup");
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  expect((await space(panes[1])).defaultPrevented).toBe(false);
  modal.remove();
  const button = document.createElement("button");
  document.body.append(button);
  expect((await space(button)).defaultPrevented).toBe(false);
  button.remove();
  container.hidden = true;
  expect((await space(document.body)).defaultPrevented).toBe(false);
});

it.each(["Shift", "Meta", "Control"])(
  "uses %s-click to extend the node selection",
  async (key) => {
    const node = firstNode();
    const clickNode = async (target: HTMLElement) => {
      await pointer(target, "pointerdown", 200, 200);
      for (const type of ["mousedown", "mouseup", "click"]) {
        await act(async () => {
          target.dispatchEvent(
            new MouseEvent(type, {
              view: window,
              bubbles: true,
              cancelable: true,
              clientX: 200,
              clientY: 200,
            }),
          );
        });
      }
      await pointer(target, "pointerup", 200, 200);
    };
    await clickNode(node);
    expect(
      flow
        .getNodes()
        .filter((node) => node.selected)
        .map((node) => node.id),
    ).toEqual(["a"]);
    await act(async () => {
      node.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          [key === "Shift"
            ? "shiftKey"
            : key === "Meta"
              ? "metaKey"
              : "ctrlKey"]: true,
        }),
      );
    });
    await clickNode(
      container.querySelector<HTMLElement>('.react-flow__node[data-id="b"]')!,
    );
    expect(
      flow
        .getNodes()
        .filter((node) => node.selected)
        .map((node) => node.id),
    ).toEqual(["a", "b"]);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    });
  },
);
