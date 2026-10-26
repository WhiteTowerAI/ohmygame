import {
  changeNodeCodebase,
  NodeCodebaseError,
} from "./playable-codebase.js";
import { playablePreset, PLAYABLE_PRESET_IDS } from "./playable-presets.js";
import { browserImports, isWebStory } from "./story-web-project.js";
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
  const source = {
    html: `nodes/${request.id}/index.html`,
    css: `nodes/${request.id}/style.css`,
    javascript: `nodes/${request.id}/node.js`,
  };
  let title = "";
  let nodeFiles: string[] = [];
  // Read and written as one step, so a save from the editor cannot land in between and be lost.
  await changeNodeCodebase(workspacePath, async (codebase) => {
    const web = await isWebStory(workspacePath);
    // Nodes are named in order, not after their Preset: a Preset is only a starting point.
    title = (request.title ?? nextNodeTitle(codebase.graph.nodes)).trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) throw new NodeCodebaseError("A Node title is required.");

    if (codebase.graph.nodes.some((node) => node.id === request.id)) {
      throw new NodeCodebaseError(`Node "${request.id}" already exists.`);
    }
    // Without a title the starter text keeps the Preset's own wording.
    const starter = preset.source(request.title ? title : preset.label, request.id);
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
        [request.id]: request.position ?? freePlayablePosition(codebase.editorLayout, codebase.graph.viewport),
      },
    };
    // A web story loads Scene modules as they are, so they use imports a browser understands.
    if (web) starter.javascript = browserImports(starter.javascript);
    // A Template's further files belong to the new Node, so they replace any left by a removed Node of the same ID.
    const files = Object.fromEntries(
      Object.entries(starter.files ?? {}).map(([name, content]) => [`nodes/${request.id}/${name}`, content]),
    );
    nodeFiles = Object.keys(files);
    return {
      graph,
      editorLayout,
      sources: {
        [source.html]: starter.html,
        [source.css]: starter.css,
        [source.javascript]: starter.javascript,
      },
      files,
      ...(preset.sharedFiles ? { missingFiles: preset.sharedFiles } : {}),
      ...(preset.sharedFileCopies ? { missingFileCopies: preset.sharedFileCopies } : {}),
    };
  });
  return {
    id: request.id,
    title,
    preset: preset.id,
    files: [source.html, source.css, source.javascript, ...nodeFiles],
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

