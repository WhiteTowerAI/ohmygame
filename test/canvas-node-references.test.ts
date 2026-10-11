import { describe, expect, it } from "vitest";
import type { AssetCanvasNode } from "../src/shared/contracts.js";
import { createAssetCanvasDocument, isAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { MAX_TEXT_NODE_REFERENCES } from "../src/shared/asset-canvas-schema.js";
import { connectionRelation, removeNodesAndReferences, toAssetCanvasNode } from "../src/renderer/asset-canvas-workspace.js";
import { createCanvasClipboard, duplicateCanvasSelection, parseCanvasClipboard } from "../src/renderer/asset-canvas-clipboard.js";
import { mergeCanvasDocument } from "../src/shared/canvas-workspace.js";

const position = { x: 0, y: 0 };
const ref = (nodeId: string) => ({ type: "node" as const, nodeId });
const source: AssetCanvasNode = { id: "brief", type: "text", position, data: { text: "A forest adventure", instruction: "" } };
const document: AssetCanvasNode = { id: "document", type: "document", position, data: { documentId: "rules", references: [ref(source.id)] } };
const image: AssetCanvasNode = { id: "image", type: "image", position, data: { prompt: "forest", resolution: "1K", aspectRatio: "1:1", images: [] } };
const text: AssetCanvasNode = { id: "text", type: "text", position, data: { text: "", instruction: "Summarize", references: [ref(source.id), ref(document.id), ref(image.id)] } };
function canvas(nodes: AssetCanvasNode[]) {
  const canvas = createAssetCanvasDocument();
  canvas.nodes = nodes;
  canvas.editorLayout.nodes = Object.fromEntries(nodes.map((node) => [node.id, node.position]));
  return canvas;
}

describe("Text and Document node references", () => {
  it("saves multiple reference kinds and still accepts nodes without references", () => {
    expect(isAssetCanvasDocument(canvas([source, document, image, text]))).toBe(true);
    expect(isAssetCanvasDocument(canvas([source]))).toBe(true);
    for (const node of [text, document]) {
      const serialized = toAssetCanvasNode({ ...node, data: { ...node.data, textRuntime: undefined, documentRuntime: undefined } });
      expect(serialized).toEqual(node);
    }
  });

  it.each(["text", "document"] as const)("connects valid sources to %s with duplicate, self and capacity checks", (type) => {
    const target = type === "text" ? { ...text, data: { ...text.data, references: [] } } : { ...document, data: { ...document.data, references: [] } };
    for (const candidate of [source, image, { ...document, id: "other-doc", data: { documentId: "other" } }]) {
      expect(connectionRelation(candidate, target, "out", [], [], [])).toBe("text-reference");
    }
    expect(connectionRelation(target, target, "out", [], [], [])).toBeUndefined();
    expect(connectionRelation(source, { ...target, data: { ...target.data, references: [ref(source.id)] } }, "out", [], [], [])).toBeUndefined();
    expect(connectionRelation(source, { ...target, data: { ...target.data, references: Array.from({ length: MAX_TEXT_NODE_REFERENCES }, (_, i) => ref(`ref-${i}`)) } }, "out", [], [], [])).toBeUndefined();
    expect(connectionRelation({ id: "video", type: "asset", position, data: { assetId: "movie", mediaType: "video" } }, target, "out", [], [], [])).toBeUndefined();
    if (type === "document") expect(connectionRelation({ ...document, id: "alias" }, target, "out", [], [], [])).toBeUndefined();
  });

  it.each(["missing", "self", "same-document", "audio", "duplicate", "over-limit"])("rejects %s references in persisted boards", (invalid) => {
    const nodes: AssetCanvasNode[] = structuredClone([source, document, image, text]);
    const target = nodes[1]! as Extract<AssetCanvasNode, { type: "document" }>;
    if (invalid === "missing") target.data.references = [ref("missing")];
    if (invalid === "self") target.data.references = [ref(target.id)];
    if (invalid === "same-document") { nodes.push({ ...document, id: "alias" }); target.data.references = [ref("alias")]; }
    if (invalid === "audio") { nodes.push({ id: "audio", type: "asset", position, data: { assetId: "audio", mediaType: "audio" } }); target.data.references = [ref("audio")]; }
    if (invalid === "duplicate") target.data.references = [ref(source.id), ref(source.id)];
    if (invalid === "over-limit") {
      target.data.references = Array.from({ length: MAX_TEXT_NODE_REFERENCES + 1 }, (_, i) => ref(`extra-${i}`));
      nodes.push(...target.data.references.map((reference): AssetCanvasNode => ({ ...source, id: reference.nodeId })));
    }
    expect(isAssetCanvasDocument(canvas(nodes))).toBe(false);
  });

  it("removes deleted sources from both text and document references and from merged remote edits", () => {
    const nodes = [source, document, image, text];
    const flow = removeNodesAndReferences(nodes, new Set([source.id]));
    expect(flow.find((node) => node.id === document.id)?.data.references).toEqual([]);
    expect(flow.find((node) => node.id === text.id)?.data.references).toEqual([ref(document.id), ref(image.id)]);
    const base = canvas(nodes), local = structuredClone(base), remote = structuredClone(base);
    remote.nodes = remote.nodes.filter((node) => node.id !== source.id);
    const merged = mergeCanvasDocument(base, local, remote)!;
    expect(merged.nodes.find((node) => node.id === document.id)?.data).toMatchObject({ references: [] });
    expect(isAssetCanvasDocument(merged)).toBe(true);
  });

  it("copies internal references and drops links outside the selection", () => {
    const copied = createCanvasClipboard("project", [source, document, text], []);
    expect(parseCanvasClipboard(JSON.stringify(copied))).toEqual(copied);
    let id = 0;
    const result = duplicateCanvasSelection(copied.nodes, copied.edges, position, () => `copy-${++id}`);
    expect(result.nodes[1]!.data).toMatchObject({ references: [ref("copy-1")] });
    expect(result.nodes[2]!.data).toMatchObject({ references: [ref("copy-1"), ref("copy-2")] });
    expect(isAssetCanvasDocument(canvas(result.nodes))).toBe(true);
  });
});
