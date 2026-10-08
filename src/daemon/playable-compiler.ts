import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  build,
  type BuildOptions,
  type BuildResult,
  type Metafile,
  type Plugin,
} from "esbuild";
import { validateNodeGraph } from "../shared/playable-graph-validation.js";
import type {
  CompiledNodeGraph,
  CompiledPlayableSurface,
} from "../shared/playable-compiled.js";
import type {
  NodeGraph,
  NodeSource,
} from "../shared/playable-nodes.js";
import { annotatePlayableSourceLocations } from "../shared/playable-source-locations.js";

export type NodeCompilerErrorCode =
  | "invalid-graph"
  | "missing-source"
  | "path-outside-workspace"
  | "build-failed"
  | "resource-limit";

export class NodeCompilerError extends Error {
  constructor(
    readonly code: NodeCompilerErrorCode,
    message: string,
    readonly surfaceId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NodeCompilerError";
  }
}

export interface NodeCompilerOptions {
  minify?: boolean;
  sourcemap?: boolean;
  /** Annotates surface HTML elements with their source location for element picking. */
  sourceLocations?: boolean;
}

export type {
  CompiledNodeGraph,
  CompiledPlayableSurface,
} from "../shared/playable-compiled.js";

const EMBEDDED_LOADERS: NonNullable<BuildOptions["loader"]> = {
  ".avif": "dataurl",
  ".gif": "dataurl",
  ".jpeg": "dataurl",
  ".jpg": "dataurl",
  ".png": "dataurl",
  ".svg": "dataurl",
  ".webp": "dataurl",
  ".mp3": "dataurl",
  ".ogg": "dataurl",
  ".wav": "dataurl",
  ".mp4": "dataurl",
  ".webm": "dataurl",
  ".otf": "dataurl",
  ".ttf": "dataurl",
  ".woff": "dataurl",
  ".woff2": "dataurl",
  ".glb": "binary",
  ".gltf": "json",
  ".wasm": "binary",
  ".frag": "text",
  ".glsl": "text",
  ".vert": "text",
};
const MAX_CONCURRENT_SURFACE_BUILDS = 4;
const MAX_SURFACE_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_COMPILED_SURFACE_BYTES = 16 * 1024 * 1024;

export async function compileNodeGraph(
  workspacePath: string,
  graph: NodeGraph,
  options: NodeCompilerOptions = {},
): Promise<CompiledNodeGraph> {
  const validation = validateNodeGraph(graph);
  if (!validation.ok) {
    const first = validation.issues[0]!;
    throw new NodeCompilerError(
      "invalid-graph",
      `${first.path}: ${first.message}`,
    );
  }

  const workspaceRoot = await resolveWorkspaceRoot(workspacePath);
  const resolvedFiles = new Map<string, Promise<string>>();
  const entries = await mapConcurrent(
    graph.nodes,
    MAX_CONCURRENT_SURFACE_BUILDS,
    async (node): Promise<[string, CompiledPlayableSurface]> => [
      node.id,
      await compileSurface(workspaceRoot, node.id, node.source, options, resolvedFiles),
    ],
  );
  return { version: 1, nodes: Object.fromEntries(entries) };
}

async function compileSurface(
  workspaceRoot: string,
  surfaceId: string,
  source: NodeSource,
  options: NodeCompilerOptions,
  resolvedFiles: Map<string, Promise<string>>,
): Promise<CompiledPlayableSurface> {
  const [htmlPath, cssPath, javascriptPath] = await Promise.all([
    resolveSourceFile(workspaceRoot, source.html, surfaceId),
    resolveSourceFile(workspaceRoot, source.css, surfaceId),
    resolveSourceFile(workspaceRoot, source.javascript, surfaceId),
  ]);
  const boundary = workspaceBoundaryPlugin(workspaceRoot, surfaceId, resolvedFiles);

  try {
    const [html, buildResult] = await Promise.all([
      readLimitedText(htmlPath, surfaceId),
      bundleSurface(
        workspaceRoot,
        cssPath,
        javascriptPath,
        boundary.plugin,
        options,
      ),
    ]);
    assertNoExternalImports(buildResult.metafile);
    const explicitCss = outputText(buildResult, "style.css");
    const importedCss = outputText(buildResult, "script.css", false);
    const javascript = outputText(buildResult, "script.js");
    if (!outputExports(buildResult.metafile, "script.js").includes("mount")) {
      throw new NodeCompilerError(
        "build-failed",
        `Playable surface "${surfaceId}" JavaScript must export "mount".`,
        surfaceId,
      );
    }
    const inputs = new Set<string>([
      relativePath(workspaceRoot, htmlPath),
      ...metafileInputs(buildResult.metafile),
    ]);

    const compiled = {
      id: surfaceId,
      html: options.sourceLocations
        ? annotatePlayableSourceLocations(html, source.html)
        : html,
      css: [explicitCss, importedCss].filter(Boolean).join("\n"),
      javascript,
      inputs: [...inputs].sort(),
    };
    const compiledBytes = Buffer.byteLength(compiled.html) + Buffer.byteLength(compiled.css) + Buffer.byteLength(compiled.javascript);
    if (compiledBytes > MAX_COMPILED_SURFACE_BYTES) {
      throw new NodeCompilerError(
        "resource-limit",
        `Playable surface "${surfaceId}" exceeds the 16 MiB compiled size limit.`,
        surfaceId,
      );
    }
    return compiled;
  } catch (cause) {
    if (boundary.violation) throw boundary.violation;
    if (cause instanceof NodeCompilerError) throw cause;
    throw new NodeCompilerError(
      "build-failed",
      `Failed to compile Playable surface "${surfaceId}": ${errorMessage(cause)}`,
      surfaceId,
      { cause },
    );
  }
}

async function readLimitedText(file: string, surfaceId: string): Promise<string> {
  const details = await stat(file);
  if (details.size > MAX_SURFACE_SOURCE_BYTES) {
    throw new NodeCompilerError(
      "resource-limit",
      `Playable surface "${surfaceId}" contains a source file larger than 5 MiB.`,
      surfaceId,
    );
  }
  return readFile(file, "utf8");
}

async function bundleSurface(
  workspaceRoot: string,
  cssEntryPoint: string,
  javascriptEntryPoint: string,
  boundary: Plugin,
  options: NodeCompilerOptions,
): Promise<BuildResult<{ metafile: true }>> {
  return build({
    absWorkingDir: workspaceRoot,
    entryPoints: { style: cssEntryPoint, script: javascriptEntryPoint },
    outdir: ".playable-build",
    entryNames: "[name]",
    assetNames: "assets/[name]-[hash]",
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: EMBEDDED_LOADERS,
    legalComments: "none",
    logLevel: "silent",
    minify: options.minify ?? false,
    sourcemap: options.sourcemap ? "inline" : false,
    plugins: [boundary],
  });
}

function workspaceBoundaryPlugin(
  workspaceRoot: string,
  surfaceId: string,
  resolvedFiles: Map<string, Promise<string>>,
): { plugin: Plugin; violation?: NodeCompilerError } {
  const boundary: { plugin: Plugin; violation?: NodeCompilerError } = {
    plugin: {
      name: "playable-workspace-boundary",
      setup(context) {
        // Check each loaded file instead of resolving every import a second
        // time. Large package barrels otherwise trigger thousands of resolver
        // round trips, repeated for every Scene that imports the package.
        context.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
          try {
            let resolution = resolvedFiles.get(args.path);
            if (!resolution) {
              resolution = realpath(args.path);
              resolvedFiles.set(args.path, resolution);
            }
            const resolved = await resolution;
            assertInsideWorkspace(
              workspaceRoot,
              resolved,
              surfaceId,
              args.path,
            );
          } catch (cause) {
            if (cause instanceof NodeCompilerError) {
              boundary.violation ??= cause;
              return { errors: [{ text: cause.message }] };
            }
            return {
              errors: [
                {
                  text: `Cannot load "${args.path}" inside the project workspace: ${errorMessage(cause)}`,
                },
              ],
            };
          }
          // Let esbuild use its normal loader after the boundary check.
        });
      },
    },
  };
  return boundary;
}

function assertNoExternalImports(metafile: Metafile): void {
  // Input metadata retains imports removed from the output by tree shaking.
  for (const input of Object.values(metafile.inputs)) {
    for (const imported of input.imports) {
      if (!imported.external) continue;
      const requestedPath = imported.original ?? imported.path;
      if (requestedPath.startsWith("data:") || requestedPath.startsWith("#")) continue;
      throw new Error(`External import "${requestedPath}" is not allowed in Playable surfaces.`);
    }
  }
}

async function resolveWorkspaceRoot(workspacePath: string): Promise<string> {
  try {
    const root = await realpath(workspacePath);
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
    return root;
  } catch (cause) {
    throw new NodeCompilerError(
      "missing-source",
      `Playable workspace does not exist or is not a directory: ${workspacePath}`,
      undefined,
      { cause },
    );
  }
}

async function resolveSourceFile(
  workspaceRoot: string,
  sourcePath: string,
  surfaceId: string,
): Promise<string> {
  const candidate = path.resolve(workspaceRoot, ...sourcePath.split("/"));
  assertInsideWorkspace(workspaceRoot, candidate, surfaceId, sourcePath);
  try {
    const resolved = await realpath(candidate);
    assertInsideWorkspace(workspaceRoot, resolved, surfaceId, sourcePath);
    const details = await stat(resolved);
    if (!details.isFile()) throw new Error("not a file");
    if (details.size > MAX_SURFACE_SOURCE_BYTES) {
      throw new NodeCompilerError(
        "resource-limit",
        `Playable surface "${surfaceId}" contains a source file larger than 5 MiB.`,
        surfaceId,
      );
    }
    return resolved;
  } catch (cause) {
    if (cause instanceof NodeCompilerError) throw cause;
    throw new NodeCompilerError(
      "missing-source",
      `Playable surface "${surfaceId}" references missing source file "${sourcePath}".`,
      surfaceId,
      { cause },
    );
  }
}

function assertInsideWorkspace(
  workspaceRoot: string,
  target: string,
  surfaceId: string,
  requestedPath: string,
): void {
  const relative = path.relative(workspaceRoot, target);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    return;
  throw new NodeCompilerError(
    "path-outside-workspace",
    `Playable surface "${surfaceId}" cannot load "${requestedPath}" because it resolves outside the project workspace.`,
    surfaceId,
  );
}

function outputText(
  result: BuildResult,
  fileName: string,
  required = true,
): string {
  const output = result.outputFiles?.find(
    (file) => path.basename(file.path) === fileName,
  );
  if (output) return output.text;
  if (!required) return "";
  throw new Error(`esbuild did not produce ${fileName}`);
}

function metafileInputs(metafile: Metafile | undefined): string[] {
  if (!metafile) return [];
  return Object.keys(metafile.inputs).map((input) =>
    input.replaceAll(path.sep, "/"),
  );
}

function outputExports(
  metafile: Metafile | undefined,
  fileName: string,
): string[] {
  if (!metafile) return [];
  return Object.entries(metafile.outputs).flatMap(([outputPath, output]) =>
    path.basename(outputPath) === fileName ? output.exports : [],
  );
}

function relativePath(workspaceRoot: string, target: string): string {
  return path.relative(workspaceRoot, target).replaceAll(path.sep, "/");
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (!failed && nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await transform(values[index]!);
        } catch (cause) {
          if (!failed) {
            failed = true;
            failure = cause;
          }
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}
