import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canvasNodeInputs, canvasNodeParams } from "../shared/canvas-plugin-nodes.js";
import { mediaFileInfo } from "../shared/media-files.js";
import type { AssetLibrary } from "./asset-library.js";
import { CanvasError } from "./canvas-files.js";
import type { CanvasPluginRunner } from "./canvas-workspace.js";
import type { NativePlugins } from "./native-plugins.js";
import { localizePluginString } from "./plugin-index.js";

/** The largest file a canvas node may make. */
export const CANVAS_NODE_OUTPUT_MAX_BYTES = 512 * 1024 * 1024;
/** The longest text a canvas node may make. */
export const CANVAS_NODE_TEXT_MAX_LENGTH = 100_000;

/**
 * Runs plugins' canvas nodes. The node's code gets its settings, its inputs
 * (files by path, text as text) and an empty folder; it returns the name of
 * the file it wrote there, or `{ text }`. The file goes into the Library.
 */
export function canvasPluginRunner(options: { native: NativePlugins; library: AssetLibrary }): CanvasPluginRunner {
  return {
    async run(project, request, signal) {
      const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-canvas-node-"));
      try {
        return await options.native.runCanvasNode(request.node, {
          folder: project.workspacePath,
          signal,
          prepare: async (definition, entry) => {
            const title = (text: string) => localizePluginString(entry, text, "en");
            try {
              return { params: canvasNodeParams(definition, request.params, title), inputs: canvasNodeInputs(definition, request.inputs, title), output: folder };
            } catch (cause) {
              throw new CanvasError(cause instanceof Error ? cause.message : String(cause), 400);
            }
          },
          result: async (value, definition) => {
            const result = (value && typeof value === "object" ? value : {}) as { file?: unknown; text?: unknown };
            if (definition.output === "text") {
              if (typeof result.text !== "string") throw new CanvasError(`${request.node} returned no text`, 502);
              if (result.text.length > CANVAS_NODE_TEXT_MAX_LENGTH) throw new CanvasError(`${request.node} returned more than ${CANVAS_NODE_TEXT_MAX_LENGTH} characters`, 502);
              return { text: result.text };
            }
            if (typeof result.file !== "string" || !result.file) throw new CanvasError(`${request.node} returned no file`, 502);
            // Only a file the code wrote into its folder: no links, nothing outside it.
            const root = await realpath(folder);
            const file = await realpath(path.resolve(root, result.file)).catch(() => undefined);
            const relative = file && path.relative(root, file);
            if (!file || !relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new CanvasError(`${request.node} returned ${result.file}, which isn't a file it wrote in its output folder`, 502);
            const stats = await lstat(file).catch(() => undefined);
            if (!stats?.isFile()) throw new CanvasError(`${request.node} returned ${result.file}, which isn't a file it wrote`, 502);
            if (stats.size > CANVAS_NODE_OUTPUT_MAX_BYTES) throw new CanvasError(`${request.node} made a file larger than ${CANVAS_NODE_OUTPUT_MAX_BYTES / 1024 / 1024} MB`, 502);
            const media = mediaFileInfo(file);
            if (media?.mediaType !== definition.output) throw new CanvasError(`${request.node} should make ${definition.output === "model" ? "a 3D model" : `${definition.output === "image" ? "an" : "a"} ${definition.output}`}, not ${path.basename(file)}`, 502);
            signal.throwIfAborted();
            const asset = await options.library.addFile(path.basename(file), file, { origin: "generated", sourceKey: `canvas-plugin:${project.id}:${randomUUID()}` });
            return { assetId: asset.id };
          },
        });
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    describe: (project, node) => options.native.canvasNodePackage(project.workspacePath, node).catch(() => undefined),
  };
}
