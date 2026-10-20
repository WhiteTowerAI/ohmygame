import { describe, expect, it } from "vitest";
import {
  createAssetCanvasDocument,
  isAssetCanvasDocument,
} from "../src/shared/asset-canvas.js";
import type {
  AssetCanvasDocument,
  AssetCanvasNode,
} from "../src/shared/contracts.js";
import { mergeCanvasDocument } from "../src/shared/canvas-workspace.js";

function canvas(): AssetCanvasDocument {
  const board = createAssetCanvasDocument();
  board.nodes = [
    {
      id: "background",
      type: "image",
      position: { x: 10, y: 20 },
      data: {
        prompt: "A garage",
        resolution: "2K",
        aspectRatio: "16:9",
        images: [],
      },
    },
  ];
  board.editorLayout.nodes.background = board.nodes[0]!.position;
  return board;
}

function convert(board: AssetCanvasDocument, assetId = "garage"): void {
  board.nodes[0] = {
    ...board.nodes[0]!,
    type: "asset",
    data: { assetId, mediaType: "image" },
  };
}

// React Flow serialization and agent JSON writes can use different object key orders.
function reorder(node: AssetCanvasNode): AssetCanvasNode {
  return {
    data: Object.fromEntries(Object.entries(node.data).reverse()),
    position: { y: node.position.y, x: node.position.x },
    type: node.type,
    id: node.id,
  } as AssetCanvasNode;
}

describe("canvas node type changes", () => {
  it.each(["local", "remote"] as const)(
    "adopts a %s conversion when the other node is unchanged",
    (side) => {
      const base = canvas(),
        local = structuredClone(base),
        remote = structuredClone(base);
      const changed = side === "local" ? local : remote;
      const unchanged = side === "local" ? remote : local;
      unchanged.nodes[0] = reorder(unchanged.nodes[0]!);
      convert(changed);

      const merged = mergeCanvasDocument(base, local, remote)!;
      expect(merged.nodes[0]).toEqual(changed.nodes[0]);
      expect(merged.nodes[0]!.data).not.toHaveProperty("prompt");
      expect(isAssetCanvasDocument(merged)).toBe(true);
    },
  );

  it("accepts identical conversions on both sides with different object key orders", () => {
    const base = canvas(),
      local = structuredClone(base),
      remote = structuredClone(base);
    convert(local);
    convert(remote);
    remote.nodes[0] = reorder(remote.nodes[0]!);

    const merged = mergeCanvasDocument(base, local, remote)!;
    expect(merged.nodes[0]).toEqual(local.nodes[0]);
    expect(isAssetCanvasDocument(merged)).toBe(true);
  });

  it.each(["local", "remote"] as const)(
    "preserves a conflict when a %s conversion competes with an edit",
    (side) => {
      const base = canvas(),
        local = structuredClone(base),
        remote = structuredClone(base);
      convert(side === "local" ? local : remote);
      (side === "local" ? remote : local).nodes[0]!.title = "My background";

      expect(mergeCanvasDocument(base, local, remote)).toBeUndefined();
    },
  );

  it("preserves a conflict between different converted assets", () => {
    const base = canvas(),
      local = structuredClone(base),
      remote = structuredClone(base);
    convert(local, "home");
    convert(remote, "garage");

    expect(mergeCanvasDocument(base, local, remote)).toBeUndefined();
  });

  it("keeps independent edits to another node and rebuilds the converted layout", () => {
    const base = canvas();
    base.nodes.push({
      id: "notes",
      type: "text",
      position: { x: 500, y: 20 },
      data: { text: "Notes", instruction: "" },
    });
    base.editorLayout.nodes.notes = base.nodes[1]!.position;
    const local = structuredClone(base),
      remote = structuredClone(base);
    local.nodes[1]!.title = "Updated notes";
    convert(remote);
    remote.nodes[0]!.position = { x: 100, y: 200 };

    const merged = mergeCanvasDocument(base, local, remote)!;
    expect(merged.nodes[0]).toEqual(remote.nodes[0]);
    expect(merged.nodes[1]!.title).toBe("Updated notes");
    expect(merged.editorLayout.nodes.background).toEqual({ x: 100, y: 200 });
    expect(isAssetCanvasDocument(merged)).toBe(true);
  });
});
