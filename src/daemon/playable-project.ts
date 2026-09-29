import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  validatePlayableGraph,
  type PlayableGraphValidationIssue,
  type PlayableGraphValidationMode,
} from "../shared/playable-graph-validation.js";
import type { PlayableGraph } from "../shared/playable-nodes.js";
import type { PlayablePlayerDefinition } from "../shared/playable-player-protocol.js";
import { compilePlayableGraph, PlayableCompilerError } from "./playable-compiler.js";
import { listWorkspaceFiles } from "./workspace.js";

export async function buildPlayableProject(
  workspacePath: string,
  mode: PlayableGraphValidationMode = "draft",
): Promise<PlayablePlayerDefinition | undefined> {
  const validation = await validatePlayableProject(workspacePath, mode);
  if (validation.missing) return undefined;
  if (!validation.ok || !validation.definition) {
    const issue = validation.issues[0]!;
    throw new Error(`${issue.path}: ${issue.message}`);
  }
  return validation.definition;
}

export interface PlayableProjectValidationIssue {
  phase: "graph" | "compiler";
  code: PlayableGraphValidationIssue["code"] | "invalid-json" | "missing-graph" | PlayableCompilerError["code"];
  path: string;
  message: string;
  surfaceId?: string;
}

export interface PlayableProjectValidationResult {
  ok: boolean;
  missing?: boolean;
  issues: PlayableProjectValidationIssue[];
  definition?: PlayablePlayerDefinition;
}

export async function validatePlayableProject(
  workspacePath: string,
  mode: PlayableGraphValidationMode = "draft",
): Promise<PlayableProjectValidationResult> {
  let source: string;
  try {
    source = await readFile(path.join(workspacePath, "graph.json"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {
      ok: false,
      missing: true,
      issues: [{ phase: "graph", code: "missing-graph", path: "/", message: "graph.json is missing." }],
    };
    throw cause;
  }

  let graph: PlayableGraph;
  try {
    graph = JSON.parse(source) as PlayableGraph;
  } catch {
    return {
      ok: false,
      issues: [{ phase: "graph", code: "invalid-json", path: "/", message: "graph.json is not valid JSON." }],
    };
  }
  const files = new Set(
    (await listWorkspaceFiles(workspacePath))
      .filter((file) => !file.directory)
      .map((file) => file.path),
  );
  const graphValidation = validatePlayableGraph(graph, {
    mode,
    availableFiles: files,
  });
  if (!graphValidation.ok) return {
    ok: false,
    issues: graphValidation.issues.map((issue) => ({ ...issue, phase: "graph" })),
  };
  let compiled;
  try {
    compiled = await compilePlayableGraph(workspacePath, graph, {
      minify: mode === "publish",
      sourcemap: mode === "draft",
    });
  } catch (cause) {
    if (!(cause instanceof PlayableCompilerError)) throw cause;
    return {
      ok: false,
      issues: [{
        phase: "compiler",
        code: cause.code,
        path: cause.surfaceId ? `/surfaces/${escapePointer(cause.surfaceId)}` : "/",
        message: cause.message,
        ...(cause.surfaceId ? { surfaceId: cause.surfaceId } : {}),
      }],
    };
  }
  const graphSignature = createHash("sha256")
    .update(JSON.stringify({ graph, compiled }))
    .digest("hex");
  return { ok: true, issues: [], definition: { version: 1, graph, compiled, graphSignature } };
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
