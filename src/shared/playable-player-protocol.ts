import type { CompiledNodeGraph } from "./playable-compiled.js";
import type { NodeGraph } from "./playable-nodes.js";
import type {
  NodeRuntimeSnapshot,
  PlayableSave,
} from "./playable-runtime.js";

export interface NodePlayerDefinition {
  version: 1;
  graph: NodeGraph;
  compiled: CompiledNodeGraph;
  graphSignature: string;
}

export interface NodeRuntimeResponse {
  definition: NodePlayerDefinition;
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
    }
  | {
      kind: "ohmygame:playable:save-result";
      instanceId: string;
      requestId: string;
      error?: string;
    };

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
    };

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
    return isRecord(value.definition) && isRecord(value.assets);
  }
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
  return (
    (value.kind === "ohmygame:playable:error" ||
      value.kind === "ohmygame:playable:diagnostic") &&
    typeof value.error === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
