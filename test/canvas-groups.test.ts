import { describe, expect, it } from "vitest";
import type { AssetCanvasNode } from "../src/shared/contracts.js";
import {
  createAssetCanvasDocument,
  isAssetCanvasDocument,
  validateAssetCanvasDocument,
} from "../src/shared/asset-canvas.js";
import { canvasNodeLayout } from "../src/shared/canvas-node-layout.js";
import {
  duplicateCanvasSelection,
  parseCanvasClipboard,
  createCanvasClipboard,
} from "../src/renderer/asset-canvas-clipboard.js";
import {
  clampCanvasGroupResize,
  canvasAbsolutePosition,
  canvasDescendantIds,
  canvasDropGroup,
  expandCanvasGroups,
  orderedCanvasNodes,
  reparentCanvasNode,
} from "../src/renderer/canvas-groups.js";

const group = (
  id: string,
  x: number,
  y: number,
  parentId?: string,
): AssetCanvasNode => ({
  id,
  type: "group",
  position: { x, y },
  ...(parentId ? { parentId } : {}),
  width: 500,
  height: 400,
  data: { name: id },
});
const text = (
  id: string,
  x: number,
  y: number,
  parentId?: string,
): AssetCanvasNode => ({
  id,
  type: "text",
  position: { x, y },
  ...(parentId ? { parentId } : {}),
  data: { text: id, instruction: "" },
});

describe("canvas groups", () => {
  it("stops all four resize edges at child bounds, including nested coordinates", () => {
    const outer = group("outer", 100, 100);
    const inner = { ...group("inner", 50, 60, "outer"), width: 500, height: 400 };
    const child = { ...text("child", 80, 90, "inner"), width: 300, height: 190 };
    const nodes = [outer, inner, child];
    const bounds = { x: 130, y: 150, width: 300, height: 190 };
    expect(clampCanvasGroupResize(inner, nodes, bounds)).toEqual(bounds);
    expect(clampCanvasGroupResize(inner, nodes, { ...bounds, x: 131, width: 299 })).toEqual(bounds);
    expect(clampCanvasGroupResize(inner, nodes, { ...bounds, y: 151, height: 189 })).toEqual(bounds);
    expect(clampCanvasGroupResize(inner, nodes, { ...bounds, width: 299 })).toEqual(bounds);
    expect(clampCanvasGroupResize(inner, nodes, { ...bounds, height: 189 })).toEqual(bounds);
    expect(clampCanvasGroupResize(outer, nodes, { x: 100, y: 100, width: 549, height: 460 })).toEqual({ x: 100, y: 100, width: 549, height: 460 });
    const wideOuter = { ...outer, width: 700, height: 600 };
    expect(clampCanvasGroupResize(wideOuter, [wideOuter, inner, child], { x: 100, y: 100, width: 550, height: 460 }).width).toBe(550);
    expect(clampCanvasGroupResize(wideOuter, [wideOuter, inner, child], { x: 100, y: 100, width: 549, height: 460 }).width).toBe(550);
    const narrowInner = { ...inner, width: 100 };
    expect(clampCanvasGroupResize(outer, [outer, narrowInner, child], { x: 100, y: 100, width: 430, height: 460 }).width).toBe(430);
    expect(clampCanvasGroupResize(outer, [outer, narrowInner, child], { x: 100, y: 100, width: 429, height: 460 }).width).toBe(430);
    const protruding = { ...child, position: { x: -20, y: 90 } };
    expect(clampCanvasGroupResize(inner, [outer, inner, protruding], { x: 50, y: 60, width: 490, height: 400 }).width).toBe(490);
    expect(clampCanvasGroupResize(inner, [outer, inner, protruding], { x: 50, y: 60, width: 279, height: 400 }).width).toBe(280);
  });
  it("validates nested groups and rejects missing or cyclic parents", () => {
    const canvas = createAssetCanvasDocument();
    canvas.nodes = [
      group("outer", 100, 100),
      group("inner", 30, 40, "outer"),
      text("child", 20, 60, "inner"),
    ];
    canvas.editorLayout.nodes = Object.fromEntries(
      canvas.nodes.map((node) => [node.id, canvasNodeLayout(node)]),
    );
    expect(isAssetCanvasDocument(canvas)).toBe(true);
    canvas.nodes[0]!.parentId = "inner";
    expect(() => validateAssetCanvasDocument(canvas)).toThrow(
      "invalid parent group",
    );
    canvas.nodes[0]!.parentId = "missing";
    expect(() => validateAssetCanvasDocument(canvas)).toThrow(
      "invalid parent group",
    );
  });

  it("keeps absolute positions when moving a node between nested groups", () => {
    const nodes = [
      group("outer", 100, 100),
      group("inner", 30, 40, "outer"),
      text("child", 20, 60, "inner"),
      group("target", 700, 100),
    ];
    const child = nodes[2]!;
    expect(canvasAbsolutePosition(child, nodes)).toEqual({ x: 150, y: 200 });
    expect(reparentCanvasNode(child, "outer", nodes).position).toEqual({
      x: 50,
      y: 100,
    });
    expect(reparentCanvasNode(child, undefined, nodes).position).toEqual({
      x: 150,
      y: 200,
    });
    expect(canvasDescendantIds(nodes, new Set(["outer"]))).toEqual(
      new Set(["outer", "inner", "child"]),
    );
    expect(
      orderedCanvasNodes([child, nodes[1]!, nodes[0]!]).map((node) => node.id),
    ).toEqual(["outer", "inner", "child"]);
    expect(
      canvasDropGroup(
        { ...child, parentId: undefined, position: { x: 750, y: 160 } },
        nodes,
      ),
    ).toBe("target");
  });

  it("expands nested frames around children without moving them on the canvas", () => {
    const nodes = [
      group("outer", 100, 100),
      group("inner", 20, 40, "outer"),
      text("child", -50, 300, "inner"),
    ];
    const before = canvasAbsolutePosition(nodes[2]!, nodes);
    const expanded = expandCanvasGroups(nodes);
    expect(canvasAbsolutePosition(expanded[2]!, expanded)).toEqual(before);
    expect(expanded[1]!.position.x).toBeLessThan(20);
    expect(expanded[1]!.height).toBeGreaterThan(400);
    expect(expanded[0]!.position.x).toBeLessThanOrEqual(100);
    expect(expanded[0]!.height).toBeGreaterThanOrEqual(400);
  });

  it("copies nested groups with remapped parents and relative child positions", () => {
    const source = [
      group("outer", 100, 100),
      group("inner", 30, 40, "outer"),
      text("child", 20, 60, "inner"),
    ];
    const clipboard = createCanvasClipboard("project", source, []);
    expect(parseCanvasClipboard(JSON.stringify(clipboard))).toEqual(clipboard);
    let id = 0;
    const copy = duplicateCanvasSelection(
      source,
      [],
      { x: 600, y: 300 },
      () => `copy-${++id}`,
    );
    expect(
      copy.nodes.map((node) => ({
        id: node.id,
        parentId: node.parentId,
        position: node.position,
      })),
    ).toEqual([
      { id: "copy-1", parentId: undefined, position: { x: 600, y: 300 } },
      { id: "copy-2", parentId: "copy-1", position: { x: 30, y: 40 } },
      { id: "copy-3", parentId: "copy-2", position: { x: 20, y: 60 } },
    ]);
  });
});

it("chooses the deepest target regardless of node order and never targets another moving tree", () => {
  const outer = { ...group("outer", 0, 0), width: 1400, height: 1200 };
  const inner = group("inner", 100, 100, "outer");
  const child = {
    ...text("child", 200, 200),
    measured: { width: 100, height: 80 },
  };
  expect(canvasDropGroup(child, [inner, child, outer])).toBe("inner");
  expect(
    canvasDropGroup(child, [inner, child, outer], new Set(["outer", "child"])),
  ).toBeUndefined();
});

it("keeps a partly overlapping child in its group so the frame can grow", () => {
  const frame = group("frame", 100, 100);
  const child = {
    ...text("child", 450, 100, "frame"),
    measured: { width: 160, height: 80 },
  };
  expect(canvasDropGroup(child, [frame, child])).toBe("frame");
  const expanded = expandCanvasGroups([frame, child]);
  expect(expanded[0]!.width).toBeGreaterThan(500);
  const outside = { ...child, position: { x: 700, y: 100 } };
  expect(canvasDropGroup(outside, [frame, outside])).toBeUndefined();
});

it("excludes descendants selected across unselected intermediate groups", async () => {
  const { canvasSelectionRoots } =
    await import("../src/renderer/canvas-groups.js");
  const nodes = [
    group("outer", 0, 0),
    group("inner", 20, 40, "outer"),
    text("child", 20, 40, "inner"),
  ];
  expect(
    canvasSelectionRoots(nodes, new Set(["outer", "child"])).map(
      (node) => node.id,
    ),
  ).toEqual(["outer"]);
});
