import type { PluginContributions } from "./plugin-manifest.js";
import type { AssetCanvasEdge, AssetCanvasNode } from "./contracts.js";
import { createAssetCanvasDocument, isAssetCanvasDocument, validateAssetCanvasDocument } from "./asset-canvas.js";
import { canvasNodeLayout } from "./canvas-node-layout.js";
import { migrateLegacyAudioNodes } from "./audio-legacy.js";

// The rules a plugin's canvas node holds its settings and inputs to, shared
// by the node's form and the daemon that runs it.

export type CanvasNodeDefinition = NonNullable<PluginContributions["canvasNodes"]>[number];
export type CanvasNodeParamValue = string | number | boolean;

/** A setting's value as the node shows it: what the person chose, else the plugin's default. */
export function canvasNodeParamValue(
  param: { type: string; default?: CanvasNodeParamValue; options?: readonly string[]; minimum?: number },
  value: CanvasNodeParamValue | undefined,
): CanvasNodeParamValue {
  if (value !== undefined) return value;
  if (param.default !== undefined) return param.default;
  return param.type === "boolean" ? false : param.type === "number" ? (param.minimum ?? 0) : param.type === "select" ? param.options?.[0] ?? "" : "";
}

/**
 * The values a node's code gets: every setting the plugin declares, with
 * its default where the person chose none. Throws, naming the setting by
 * `title`, when a value doesn't fit.
 */
export function canvasNodeParams(
  definition: CanvasNodeDefinition,
  values: Record<string, CanvasNodeParamValue>,
  title: (text: string) => string = (text) => text,
): Record<string, CanvasNodeParamValue> {
  const params: Record<string, CanvasNodeParamValue> = {};
  for (const [key, param] of Object.entries(definition.params ?? {})) {
    const value = canvasNodeParamValue(param, Object.hasOwn(values, key) ? values[key] : undefined);
    const name = title(param.title);
    const expected = param.type === "boolean" ? "boolean" : param.type === "number" ? "number" : "string";
    if (typeof value !== expected || (typeof value === "number" && !Number.isFinite(value)))
      throw new Error(`${name} must be a ${expected === "string" ? "text" : expected}`);
    if (typeof value === "number" && ((param.minimum !== undefined && value < param.minimum) || (param.maximum !== undefined && value > param.maximum)))
      throw new Error(`${name} must be between ${param.minimum ?? "-∞"} and ${param.maximum ?? "∞"}`);
    if (param.type === "select" && !param.options?.includes(String(value)))
      throw new Error(`${name} must be one of: ${param.options?.join(", ")}`);
    params[key] = value;
  }
  return params;
}

/**
 * Checks the inputs against what the node takes: each required one is
 * connected, one source where it takes one, and of the type it accepts.
 * Inputs the node doesn't declare are left out.
 */
export function canvasNodeInputs<T extends { type: string }>(
  definition: CanvasNodeDefinition,
  inputs: Record<string, T[]>,
  title: (text: string) => string = (text) => text,
): Record<string, T[]> {
  const checked: Record<string, T[]> = {};
  for (const input of definition.inputs ?? []) {
    const sources = Object.hasOwn(inputs, input.id) ? inputs[input.id]! : [];
    const name = title(input.title);
    if (!sources.length && !input.optional) throw new Error(`Connect something to ${name}`);
    if (sources.length > 1 && !input.multiple) throw new Error(`${name} takes one ${input.accepts}`);
    if (sources.some((source) => source.type !== input.accepts)) throw new Error(`${name} takes ${input.accepts === "model" ? "3D model" : input.accepts} only`);
    checked[input.id] = sources;
  }
  return checked;
}

/** What a preset file holds: nodes and the edges between them, no outputs and nothing from a Library. */
export interface CanvasPresetBoard {
  nodes: AssetCanvasNode[];
  edges: AssetCanvasEdge[];
}

export const CANVAS_PRESET_MAX_NODES = 200;
export const CANVAS_PRESET_MAX_BYTES = 1024 * 1024;
/** Nodes that stand on their own; documents, tables, files and assets name things in one project. */
const PRESET_NODE_TYPES: ReadonlySet<string> = new Set(["text", "image", "video", "audio", "model-3d", "animate-3d", "group", "plugin"]);

/** Why a preset file can't be added to a board, or nothing when it can. */
export function canvasPresetIssue(value: unknown): string | undefined {
  value = migrateLegacyAudioNodes(value).value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "must be an object with nodes and edges";
  const { nodes, edges = [], ...rest } = value as { nodes?: unknown; edges?: unknown };
  if (Object.keys(rest).length) return `has fields other than nodes and edges: ${Object.keys(rest).join(", ")}`;
  if (!Array.isArray(nodes) || !nodes.length) return "needs at least one node";
  if (nodes.length > CANVAS_PRESET_MAX_NODES) return `has more than ${CANVAS_PRESET_MAX_NODES} nodes`;
  if (!Array.isArray(edges)) return "edges must be a list";
  const type = nodes.map((node: { type?: unknown } | null) => node?.type).find((type) => typeof type !== "string" || !PRESET_NODE_TYPES.has(type));
  if (type !== undefined) return `can't hold ${typeof type === "string" ? `${type} nodes` : "a node without a type"}`;
  if (JSON.stringify(nodes).includes('"assetId"')) return "can't hold outputs or Library assets";
  const canvas = createAssetCanvasDocument();
  canvas.nodes = nodes as AssetCanvasNode[];
  canvas.edges = edges as AssetCanvasEdge[];
  canvas.editorLayout.nodes = Object.fromEntries(canvas.nodes.map((node) => [node.id, canvasNodeLayout(node)]));
  if (isAssetCanvasDocument(canvas)) return undefined;
  // Name the broken link when the shape is right; anything else is just not a board.
  try { validateAssetCanvasDocument(canvas); } catch (error) { if (error instanceof Error && /^(?:Node|Group|Duplicate|Asset Canvas edge) /.test(error.message)) return error.message; }
  return "isn't a valid canvas board";
}

/**
 * A preset's nodes inside one new group named after it, so the preset lands
 * as one piece. Sizes not saved in the file are guessed from a media node's.
 */
export function canvasPresetInGroup(board: CanvasPresetBoard, name: string, groupId: string): AssetCanvasNode[] {
  const roots = board.nodes.filter((node) => !node.parentId);
  const left = Math.min(...roots.map((node) => node.position.x)) - 28, top = Math.min(...roots.map((node) => node.position.y)) - 54;
  const right = Math.max(...roots.map((node) => node.position.x + (node.width ?? 440))) + 28, bottom = Math.max(...roots.map((node) => node.position.y + (node.height ?? 400))) + 28;
  const group: AssetCanvasNode = { id: groupId, type: "group", position: { x: left, y: top }, width: Math.min(4096, Math.max(500, right - left)), height: Math.min(4096, Math.max(400, bottom - top)), data: { name: name.trim().slice(0, 120) || "Preset" } };
  return [group, ...board.nodes.map((node) => node.parentId ? node : { ...node, parentId: groupId, position: { x: node.position.x - left, y: node.position.y - top } })];
}
