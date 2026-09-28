import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  validatePlayableGraph,
  type PlayableGraphValidationMode,
} from "../shared/playable-graph-validation.js";
import type { PlayableGraph } from "../shared/playable-nodes.js";
import type { PlayablePlayerDefinition } from "../shared/playable-player-protocol.js";
import { compilePlayableGraph } from "./playable-compiler.js";
import { listWorkspaceFiles } from "./workspace.js";

export async function buildPlayableProject(
  workspacePath: string,
  mode: PlayableGraphValidationMode = "draft",
): Promise<PlayablePlayerDefinition | undefined> {
  let source: string;
  try {
    source = await readFile(path.join(workspacePath, "graph.json"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }

  let graph: PlayableGraph;
  try {
    graph = JSON.parse(source) as PlayableGraph;
  } catch {
    throw new Error("graph.json is not valid JSON.");
  }
  const files = new Set(
    (await listWorkspaceFiles(workspacePath))
      .filter((file) => !file.directory)
      .map((file) => file.path),
  );
  const validation = validatePlayableGraph(graph, {
    mode,
    availableFiles: files,
  });
  if (!validation.ok) {
    const issue = validation.issues[0]!;
    throw new Error(`${issue.path}: ${issue.message}`);
  }
  const compiled = await compilePlayableGraph(workspacePath, graph, {
    minify: mode === "publish",
    sourcemap: mode === "draft",
  });
  const graphSignature = createHash("sha256")
    .update(JSON.stringify({ graph, compiled }))
    .digest("hex");
  return { version: 1, graph, compiled, graphSignature };
}
