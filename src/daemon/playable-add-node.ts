import {
  NodeCodebaseError,
  readNodeCodebase,
  writeNodeCodebase,
} from "./playable-codebase.js";
import { playablePreset, PLAYABLE_PRESET_IDS } from "./playable-presets.js";
import { freePlayablePosition, type NodeEditorLayout } from "../shared/playable-codebase.js";
import { withPlayableEntry } from "../shared/playable-graph.js";

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_TITLE_LENGTH = 120;

export interface AddPlayableNodeRequest {
  preset: string;
  id: string;
  title?: string;
  position?: { x: number; y: number };
}

export interface AddPlayableNodeResult {
  id: string;
  title: string;
  preset: string;
  /** Workspace-relative paths written for the new Node. */
  files: string[];
  signals: string[];
  /** What the author usually wants next, for the Agent to act on. */
  brief: string;
}

/**
 * Creates a Node from a Preset: copies the Preset source into `nodes/<id>/`,
 * adds the Node with its starter Signals to graph.json, and places it on the
 * canvas. The editor and the Agent both go through here, so a Node created
 * either way is identical.
 */
export async function addPlayableNode(
  workspacePath: string,
  request: AddPlayableNodeRequest,
): Promise<AddPlayableNodeResult> {
  const preset = playablePreset(request.preset);
  if (!preset) {
    throw new NodeCodebaseError(
      `Unknown Preset "${request.preset}". Available Presets: ${PLAYABLE_PRESET_IDS.join(", ")}.`,
    );
  }
  if (!NODE_ID_PATTERN.test(request.id)) {
    throw new NodeCodebaseError(
      `Invalid Node ID "${request.id}". Use letters, digits, dots, dashes, and underscores, starting with a letter or digit.`,
    );
  }
  const codebase = await readNodeCodebase(workspacePath);
  // Nodes are named in order, not after their Preset: a Preset is only a starting point.
  const title = (request.title ?? nextNodeTitle(codebase.graph.nodes)).trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) throw new NodeCodebaseError("A Node title is required.");

  if (codebase.graph.nodes.some((node) => node.id === request.id)) {
    throw new NodeCodebaseError(`Node "${request.id}" already exists.`);
  }
  const source = {
    html: `nodes/${request.id}/index.html`,
    css: `nodes/${request.id}/style.css`,
    javascript: `nodes/${request.id}/node.js`,
  };
  // Without a title the starter text keeps the Preset's own wording.
  const starter = preset.source(request.title ? title : preset.label);
  // The first Node of an empty project becomes its Start.
  const graph = withPlayableEntry({
    ...codebase.graph,
    nodes: [
      ...codebase.graph.nodes,
      {
        id: request.id,
        title,
        source,
        assets: [],
        signals: preset.signals.map((signal) => ({ ...signal })),
        ...(preset.story ? { story: { ...preset.story } } : {}),
      },
    ],
  });
  const editorLayout: NodeEditorLayout = {
    ...codebase.editorLayout,
    nodes: {
      ...codebase.editorLayout.nodes,
      [request.id]: request.position ?? freePlayablePosition(codebase.editorLayout),
    },
  };
  await writeNodeCodebase(workspacePath, {
    graph,
    editorLayout,
    sources: {
      [source.html]: starter.html,
      [source.css]: starter.css,
      [source.javascript]: starter.javascript,
    },
  });
  return {
    id: request.id,
    title,
    preset: preset.id,
    files: [source.html, source.css, source.javascript],
    signals: preset.signals.map((signal) => signal.id),
    brief: preset.brief,
  };
}

/** The first free "Node N", counting from the Nodes already in the graph. */
function nextNodeTitle(nodes: readonly { title: string }[]): string {
  const taken = new Set(nodes.map((node) => node.title));
  for (let number = nodes.length + 1; ; number += 1) {
    if (!taken.has(`Node ${number}`)) return `Node ${number}`;
  }
}

