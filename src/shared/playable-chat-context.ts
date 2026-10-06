import type { PromptContext, PromptReference } from "./contracts.js";
import type { NodeGraph, NodeSource } from "./playable-nodes.js";
import { playableTranslateValue, type PlayableTranslate } from "./playable-move.js";
import type { PlayablePickResult } from "./playable-picker.js";

/**
 * What the agent is told about the Node open in the Playable editor: where
 * its sources are, and the parts of it graph.json owns, so "this" in a
 * message needs no lookup.
 */
export function playableNodeContext(graph: NodeGraph, nodeId: string): PromptContext | undefined {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return undefined;
  const signals = node.signals.map((signal) => {
    const edge = graph.edges.find((candidate) => candidate.source.nodeId === node.id && candidate.source.signal === signal.id);
    const target = edge ? `${edge.targetNodeId} (${edge.mode})` : "not connected";
    return `- ${signal.id}${signal.label && signal.label !== signal.id ? ` "${signal.label}"` : ""} → ${target}`;
  });
  return {
    kind: "playable-node",
    label: node.title,
    text: [
      `The user has Node "${node.id}" (${node.title}) open in the Playable editor.${graph.entryNodeId === node.id ? " It is the Entry Node." : ""}`,
      `Sources: ${sourceFiles(node.source).join(", ")}`,
      signals.length ? `Signals:\n${signals.join("\n")}` : "Signals: none",
      `Assets: ${assetList(graph, node.assets)}`,
    ].join("\n"),
  };
}

/** The open Node's source files, which the agent receives as references. */
export function playableNodeReferences(graph: NodeGraph, nodeId: string): PromptReference[] {
  const source = graph.nodes.find((node) => node.id === nodeId)?.source;
  return source ? sourceFiles(source).map((path) => ({ type: "workspace-file", path })) : [];
}

/** An element the user picked in a preview, described so the agent can find it in source. */
export function playableElementContext(pick: PlayablePickResult): PromptContext {
  const excerpt = pick.text ? ` "${pick.text}"` : "";
  const box = Object.fromEntries(Object.entries(pick.box).map(([key, value]) => [key, Math.round(value)])) as PlayablePickResult["box"];
  return {
    kind: "playable-element",
    label: `<${pick.tag}>${excerpt}`.slice(0, 200),
    text: [
      `The user picked this element in the preview of Node "${pick.nodeId}":`,
      `Element: <${pick.tag}>${excerpt}`,
      ...(pick.source ? [`Source: ${pick.source}`] : ["Source: created by script; find it from the CSS path."]),
      `CSS path from the surface root: ${pick.cssPath}`,
      `Box in project viewport pixels: x ${box.x}, y ${box.y}, ${box.width}×${box.height}`,
    ].join("\n"),
  };
}

/** A drawing the user made over a preview; the attached screenshot shows it. */
export function playableDrawingContext(nodeId: string, strokes: number): PromptContext {
  return {
    kind: "playable-drawing",
    label: strokes === 1 ? "Drawing" : `Drawing (${strokes} strokes)`,
    text: `The user drew on the preview of Node "${nodeId}". The attached screenshot shows the drawing in orange, over the preview; it marks what the message is about.`,
  };
}

/**
 * An image or video the user added from a preview. The editor has declared
 * it on the Node; the user's message says where it goes.
 */
export function playableAssetContext(nodeId: string, assetId: string, asset: { name: string; type: string }): PromptContext {
  return {
    kind: "playable-asset",
    label: asset.name.slice(0, 200),
    text: [
      `The user added the ${asset.type} "${asset.name}" from the preview of Node "${nodeId}". It is declared on the Node as Asset "${assetId}"; show it with context.assets.url("${assetId}").`,
      "The message says where it goes. When an element is picked with it, it goes there. To make it the background, set data-asset and data-type on the Node's `.backdrop` element instead of replacing it.",
    ].join("\n"),
  };
}

/**
 * The chat request for a text edit that cannot be written back to surface
 * HTML, such as text a script sets or a shared component draws.
 */
export function playableTextEditRequest(before: string, after: string): string {
  return `In the preview I changed the text "${before}" to "${after}". Make that change in the source, wherever the text comes from.`;
}

/**
 * The chat request for a move that cannot be written back to surface HTML,
 * such as an element a script creates or one an animation places.
 */
export function playableMoveRequest(translate: PlayableTranslate): string {
  const value = playableTranslateValue(translate);
  return value
    ? `In the preview I dragged this element to a new place: \`translate: ${value}\` from where its layout puts it (cqw and cqh are hundredths of the screen's width and height). Move it there in the source and keep its animations working.`
    : "In the preview I dragged this element back to where its layout puts it. Remove its offset in the source.";
}

function sourceFiles(source: NodeSource): string[] {
  return [source.html, source.css, source.javascript].filter(Boolean);
}

function assetList(graph: NodeGraph, assetIds: readonly string[]): string {
  return assetIds.length
    ? assetIds.map((id) => `${id} (${graph.assets[id]?.type ?? "undeclared"})`).join(", ")
    : "none";
}
