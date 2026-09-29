import type { PromptContext, PromptReference } from "./contracts.js";
import type { NodeGraph, NodeSource } from "./playable-nodes.js";
import type { PlayablePickResult } from "./playable-picker.js";

/** The surface open in the Playable editor: a Node, or the Shell. */
export type PlayableChatSurface = { kind: "node"; nodeId: string } | { kind: "shell" };

/**
 * What the agent is told about the open surface: where its sources are, and
 * the parts of it graph.json owns, so "this" in a message needs no lookup.
 */
export function playableSurfaceContext(graph: NodeGraph, surface: PlayableChatSurface): PromptContext | undefined {
  if (surface.kind === "shell") {
    if (!graph.shell) return undefined;
    const destinations = Object.entries(graph.destinations);
    return {
      kind: "playable-node",
      label: "Shell",
      text: [
        "The user has the Shell open in the Playable editor.",
        `Sources: ${sourceFiles(graph.shell.source).join(", ")}`,
        `Destinations: ${destinations.length ? destinations.map(([key, nodeId]) => `${key} → ${nodeId}`).join(", ") : "none"}`,
        `Assets: ${assetList(graph, graph.shell.assets)}`,
      ].join("\n"),
    };
  }
  const node = graph.nodes.find((candidate) => candidate.id === surface.nodeId);
  if (!node) return undefined;
  const destinations = Object.entries(graph.destinations).filter(([, nodeId]) => nodeId === node.id).map(([key]) => key);
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
      ...(destinations.length ? [`Destinations: ${destinations.join(", ")}`] : []),
    ].join("\n"),
  };
}

/** The open surface's source files, which the agent receives as references. */
export function playableSurfaceReferences(graph: NodeGraph, surface: PlayableChatSurface): PromptReference[] {
  const source = surface.kind === "shell"
    ? graph.shell?.source
    : graph.nodes.find((node) => node.id === surface.nodeId)?.source;
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
      `The user picked this element in the preview of ${pick.nodeId === "shell" ? "the Shell" : `Node "${pick.nodeId}"`}:`,
      `Element: <${pick.tag}>${excerpt}`,
      ...(pick.source ? [`Source: ${pick.source}`] : ["Source: created by script; find it from the CSS path."]),
      `CSS path from the surface root: ${pick.cssPath}`,
      `Box in project viewport pixels: x ${box.x}, y ${box.y}, ${box.width}×${box.height}`,
    ].join("\n"),
  };
}

function sourceFiles(source: NodeSource): string[] {
  return [source.html, source.css, source.javascript].filter(Boolean);
}

function assetList(graph: NodeGraph, assetIds: readonly string[]): string {
  return assetIds.length
    ? assetIds.map((id) => `${id} (${graph.assets[id]?.type ?? "undeclared"})`).join(", ")
    : "none";
}
