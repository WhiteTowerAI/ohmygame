import { renderToStaticMarkup } from "react-dom/server";
import type { Edge, Node, ReactFlowProps } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import { EditorCanvas } from "../src/renderer/editor-canvas.js";

const flow = vi.hoisted(() => ({
  props: undefined as ReactFlowProps<Node, Edge> | undefined,
}));

// Capture the props EditorCanvas hands to React Flow, with the canvas zoomed to 2x and panned 110px right and 30px down.
vi.mock("@xyflow/react", async (original) => ({
  ...(await original<typeof import("@xyflow/react")>()),
  ReactFlow: (props: ReactFlowProps<Node, Edge>) => {
    flow.props = props;
    props.onInit?.({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
        x: (x - 110) / 2,
        y: (y - 30) / 2,
      }),
    } as never);
    return null;
  },
}));

function doubleClick(targetClass: string, addOnDoubleClick = true) {
  const onOpenMenu = vi.fn();
  renderToStaticMarkup(
    <EditorCanvas
      nodes={[]}
      addControl={null}
      onOpenMenu={onOpenMenu}
      addOnDoubleClick={addOnDoubleClick}
    />,
  );
  flow.props!.onDoubleClick!({
    target: { classList: { contains: (name: string) => name === targetClass } },
    clientX: 318,
    clientY: 238,
    preventDefault: vi.fn(),
  } as never);
  return onOpenMenu;
}

describe("EditorCanvas double-click", () => {
  it("opens the add menu at the pointer, placing nodes on the grid", () => {
    expect(doubleClick("react-flow__pane")).toHaveBeenCalledWith({
      kind: "add",
      screenPosition: { x: 318, y: 238 },
      flowPosition: { x: 100, y: 100 },
    });
  });

  it("leaves double-clicks on nodes, edges, and panels alone", () => {
    for (const target of [
      "react-flow__node",
      "react-flow__edge",
      "react-flow__panel",
    ]) {
      expect(doubleClick(target)).not.toHaveBeenCalled();
    }
  });

  it("does nothing unless the editor opts in", () => {
    expect(doubleClick("react-flow__pane", false)).not.toHaveBeenCalled();
  });
});
