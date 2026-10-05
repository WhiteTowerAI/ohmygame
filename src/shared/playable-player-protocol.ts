import type { CompiledNodeGraph } from "./playable-compiled.js";
import type { JsonObject, NodeGraph } from "./playable-nodes.js";
import type { PlayablePickResult } from "./playable-picker.js";
import type {
  NodeRuntimePolicy,
  NodeRuntimeSnapshot,
  PlayableSave,
} from "./playable-runtime.js";

export interface NodePlayerDefinition {
  version: 1;
  graph: NodeGraph;
  compiled: CompiledNodeGraph;
  graphSignature: string;
}

// `available: false` marks an Interactive Story project whose graph.json is missing.
export type NodeRuntimeResponse =
  | { available: true; definition: NodePlayerDefinition }
  | { available: false };

/**
 * Authoring options for a preview session. The Published Player never sends
 * them, and element picking is only available in sessions that have them.
 */
export interface PlayablePreviewOptions {
  policy?: NodeRuntimePolicy;
  startNodeId?: string;
  previewState?: JsonObject;
}

/**
 * An authoring tool that takes over the preview's input: `select` picks
 * elements to talk about, `text` edits an element's text in place.
 */
export type PlayablePreviewTool = "select" | "text";

/** Text the author typed over an element in the preview. */
export interface PlayableTextEdit {
  pick: PlayablePickResult;
  before: string;
  after: string;
  /**
   * The element was written in surface HTML and holds only text, so the edit
   * can go straight back to its source. Otherwise the Agent makes it.
   */
  inPlace: boolean;
}

export interface PlayableAssetTransfer {
  contentType: string;
  bytes: ArrayBuffer;
}

export type PlayableHostMessage =
  | {
      kind: "ohmygame:playable:init";
      instanceId: string;
      definition: NodePlayerDefinition;
      assets: Record<string, PlayableAssetTransfer>;
      save?: unknown;
      preview?: PlayablePreviewOptions;
    }
  | {
      kind: "ohmygame:playable:save-result";
      instanceId: string;
      requestId: string;
      error?: string;
    }
  | { kind: "ohmygame:playable:pick-start"; instanceId: string; tool: PlayablePreviewTool }
  | { kind: "ohmygame:playable:pick-cancel"; instanceId: string };

export type PlayableFrameMessage =
  | {
      kind: "ohmygame:playable:save";
      instanceId: string;
      requestId: string;
      save: PlayableSave;
    }
  | {
      kind: "ohmygame:playable:snapshot";
      instanceId: string;
      snapshot: NodeRuntimeSnapshot;
    }
  | {
      kind: "ohmygame:playable:error";
      instanceId: string;
      error: string;
    }
  | {
      kind: "ohmygame:playable:diagnostic";
      instanceId: string;
      error: string;
    }
  | {
      kind: "ohmygame:playable:picked";
      instanceId: string;
      pick: PlayablePickResult;
      /** Added to the current selection (a modifier key was held) instead of replacing it. */
      additive: boolean;
    }
  | {
      kind: "ohmygame:playable:text-edited";
      instanceId: string;
      edit: PlayableTextEdit;
    }
  | { kind: "ohmygame:playable:pick-cancelled"; instanceId: string };

export function isPlayableHostMessage(
  value: unknown,
): value is PlayableHostMessage {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.instanceId !== "string"
  )
    return false;
  if (value.kind === "ohmygame:playable:init") {
    return (
      isRecord(value.definition) &&
      isRecord(value.assets) &&
      (value.preview === undefined || isRecord(value.preview))
    );
  }
  if (value.kind === "ohmygame:playable:pick-start")
    return value.tool === "select" || value.tool === "text";
  if (value.kind === "ohmygame:playable:pick-cancel") return true;
  return (
    value.kind === "ohmygame:playable:save-result" &&
    typeof value.requestId === "string" &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function isPlayableFrameMessage(
  value: unknown,
): value is PlayableFrameMessage {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.instanceId !== "string"
  )
    return false;
  if (value.kind === "ohmygame:playable:save")
    return typeof value.requestId === "string" && isRecord(value.save);
  if (value.kind === "ohmygame:playable:snapshot")
    return isRecord(value.snapshot);
  if (value.kind === "ohmygame:playable:picked")
    return isRecord(value.pick) && typeof value.additive === "boolean";
  if (value.kind === "ohmygame:playable:text-edited")
    return (
      isRecord(value.edit) &&
      isRecord(value.edit.pick) &&
      typeof value.edit.before === "string" &&
      typeof value.edit.after === "string" &&
      typeof value.edit.inPlace === "boolean"
    );
  if (value.kind === "ohmygame:playable:pick-cancelled") return true;
  return (
    (value.kind === "ohmygame:playable:error" ||
      value.kind === "ohmygame:playable:diagnostic") &&
    typeof value.error === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
