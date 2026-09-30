import type { PromptContext, PromptReference } from "./contracts.js";
import type { NodeGraph, NodeSource } from "./playable-nodes.js";
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
 * The chat request for a text edit that cannot be written back to surface
 * HTML, such as text a script sets or a shared component draws.
 */
export function playableTextEditRequest(before: string, after: string): string {
  return `In the preview I changed the text "${before}" to "${after}". Make that change in the source, wherever the text comes from.`;
}

function sourceFiles(source: NodeSource): string[] {
  return [source.html, source.css, source.javascript].filter(Boolean);
}

function assetList(graph: NodeGraph, assetIds: readonly string[]): string {
  return assetIds.length
    ? assetIds.map((id) => `${id} (${graph.assets[id]?.type ?? "undeclared"})`).join(", ")
    : "none";
}
