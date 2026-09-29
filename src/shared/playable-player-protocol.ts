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

// `available: false` marks a Story project without graph.json. It goes away
// together with the Story runtime.
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
  | { kind: "ohmygame:playable:pick-start"; instanceId: string }
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
  if (
    value.kind === "ohmygame:playable:pick-start" ||
    value.kind === "ohmygame:playable:pick-cancel"
  )
    return true;
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
  if (value.kind === "ohmygame:playable:picked") return isRecord(value.pick);
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
