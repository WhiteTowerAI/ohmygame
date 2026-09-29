import { Errors } from "typebox/schema";
import { PLAYABLE_GRAPH_SCHEMA } from "./playable-graph-schema.js";
import { isJsonObject } from "./playable-state.js";
import type { NodeGraph, NodeSource, PlayableSignal } from "./playable-nodes.js";

export type NodeGraphValidationMode = "draft" | "publish";

export interface NodeGraphValidationIssue {
  code:
    | "schema"
    | "duplicate-id"
    | "missing-node"
    | "missing-signal"
    | "duplicate-route"
    | "missing-asset"
    | "missing-file"
    | "file-list-required"
    | "unconnected-signal"
    | "invalid-state";
  path: string;
  message: string;
}

export type NodeGraphValidationOptions =
  | { mode?: "draft"; availableFiles?: ReadonlySet<string> }
  | { mode: "publish"; availableFiles: ReadonlySet<string> };

export interface NodeGraphValidationResult {
  ok: boolean;
  issues: NodeGraphValidationIssue[];
}

export function isNodeGraph(value: unknown): value is NodeGraph {
  return validateNodeGraph(value).ok;
}

export function validateNodeGraph(
  value: unknown,
  options: NodeGraphValidationOptions = {},
): NodeGraphValidationResult {
  const [valid, schemaErrors] = Errors(PLAYABLE_GRAPH_SCHEMA, value);
  if (!valid) {
    return {
      ok: false,
      issues: schemaErrors.flatMap((error) => {
        if (error.keyword === "additionalProperties") {
          return error.params.additionalProperties.map((property) => ({
            code: "schema" as const,
            path: `${error.instancePath}/${pointer(property)}`,
            message: `Unexpected property "${property}".`,
          }));
        }
        return [
          {
            code: "schema" as const,
            path: error.instancePath || "/",
            message: error.message,
          },
        ];
      }),
    };
  }

  const graph = value as NodeGraph;
  const issues: NodeGraphValidationIssue[] = [];
  if (options.mode === "publish" && !options.availableFiles) {
    issue(
      issues,
      "file-list-required",
      "/",
      "Publish validation requires the complete set of available workspace files.",
    );
  }
  const nodes = uniqueIndex(graph.nodes, (node) => node.id, "/nodes", issues);
  uniqueIndex(graph.edges, (edge) => edge.id, "/edges", issues);

  if (!isJsonObject(graph.initialState)) {
    issue(
      issues,
      "invalid-state",
      "/initialState",
      "initialState must be a JSON-serializable object.",
    );
  }
  if (!nodes.has(graph.entryNodeId)) {
    issue(
      issues,
      "missing-node",
      "/entryNodeId",
      `Entry Node "${graph.entryNodeId}" does not exist.`,
    );
  }

  const signalKeys = new Set<string>();
  /** Signal IDs by Node. */
  const sources = new Map<string, Map<string, PlayableSignal>>();
  for (const [nodeIndex, node] of graph.nodes.entries()) {
    const signals = uniqueIndex(
      node.signals,
      (signal) => signal.id,
      `/nodes/${nodeIndex}/signals`,
      issues,
    );
    if (!sources.has(node.id)) sources.set(node.id, signals);
    for (const signal of signals.keys())
      signalKeys.add(routeKey(node.id, signal));
    validateAssetDependencies(
      node.assets,
      `/nodes/${nodeIndex}/assets`,
      `Node "${node.id}"`,
      graph,
      issues,
    );
    validateSourceFiles(
      node.source,
      `/nodes/${nodeIndex}/source`,
      options.availableFiles,
      issues,
    );
  }

  for (const [assetId, asset] of Object.entries(graph.assets)) {
    if (
      asset.source.kind === "workspace" &&
      options.availableFiles &&
      !options.availableFiles.has(asset.source.path)
    ) {
      issue(
        issues,
        "missing-file",
        `/assets/${pointer(assetId)}/source/path`,
        `Asset "${assetId}" references missing file "${asset.source.path}".`,
      );
    }
  }

  const routedSignals = new Set<string>();
  for (const [edgeIndex, edge] of graph.edges.entries()) {
    const sourceSignals = sources.get(edge.source.nodeId);
    if (!sourceSignals) {
      issue(
        issues,
        "missing-node",
        `/edges/${edgeIndex}/source/nodeId`,
        `Edge "${edge.id}" references missing source Node "${edge.source.nodeId}".`,
      );
    } else if (!sourceSignals.has(edge.source.signal)) {
      issue(
        issues,
        "missing-signal",
        `/edges/${edgeIndex}/source/signal`,
        `Edge "${edge.id}" references undeclared Signal "${edge.source.signal}" on Node "${edge.source.nodeId}".`,
      );
    }
    if (!nodes.has(edge.targetNodeId)) {
      issue(
        issues,
        "missing-node",
        `/edges/${edgeIndex}/targetNodeId`,
        `Edge "${edge.id}" targets missing Node "${edge.targetNodeId}".`,
      );
    }
    const key = routeKey(edge.source.nodeId, edge.source.signal);
    if (routedSignals.has(key)) {
      issue(
        issues,
        "duplicate-route",
        `/edges/${edgeIndex}/source`,
        `Signal "${edge.source.nodeId}.${edge.source.signal}" has more than one Edge.`,
      );
    }
    routedSignals.add(key);
  }

  if (options.mode === "publish") {
    for (const key of signalKeys) {
      if (!routedSignals.has(key)) {
        const [nodeId, signal] = splitRouteKey(key);
        issue(
          issues,
          "unconnected-signal",
          `/nodes/${graph.nodes.findIndex((node) => node.id === nodeId)}/signals`,
          `Signal "${nodeId}.${signal}" must be connected before publishing.`,
        );
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

function uniqueIndex<T>(
  items: readonly T[],
  id: (item: T) => string,
  path: string,
  issues: NodeGraphValidationIssue[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const [index, item] of items.entries()) {
    const value = id(item);
    if (result.has(value))
      issue(
        issues,
        "duplicate-id",
        `${path}/${index}/id`,
        `ID "${value}" is duplicated in this scope.`,
      );
    else result.set(value, item);
  }
  return result;
}

function validateAssetDependencies(
  assetIds: readonly string[],
  path: string,
  owner: string,
  graph: NodeGraph,
  issues: NodeGraphValidationIssue[],
): void {
  for (const [index, assetId] of assetIds.entries()) {
    if (!Object.hasOwn(graph.assets, assetId))
      issue(
        issues,
        "missing-asset",
        `${path}/${index}`,
        `${owner} references missing Asset "${assetId}".`,
      );
  }
}

function validateSourceFiles(
  source: NodeSource,
  path: string,
  files: ReadonlySet<string> | undefined,
  issues: NodeGraphValidationIssue[],
): void {
  if (!files) return;
  for (const [name, sourcePath] of Object.entries(source)) {
    if (!files.has(sourcePath))
      issue(
        issues,
        "missing-file",
        `${path}/${name}`,
        `Source file "${sourcePath}" does not exist.`,
      );
  }
}

function issue(
  issues: NodeGraphValidationIssue[],
  code: NodeGraphValidationIssue["code"],
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function pointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function routeKey(nodeId: string, signal: string): string {
  return `${nodeId}\u0000${signal}`;
}

function splitRouteKey(key: string): [string, string] {
  const separator = key.indexOf("\u0000");
  return [key.slice(0, separator), key.slice(separator + 1)];
}
