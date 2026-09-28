import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  build,
  type BuildOptions,
  type BuildResult,
  type Metafile,
  type Plugin,
} from "esbuild";
import { validatePlayableGraph } from "../shared/playable-graph-validation.js";
import type {
  CompiledPlayableGraph,
  CompiledPlayableSurface,
} from "../shared/playable-compiled.js";
import type {
  PlayableGraph,
  PlayableSource,
} from "../shared/playable-nodes.js";

export type PlayableCompilerErrorCode =
  | "invalid-graph"
  | "missing-source"
  | "path-outside-workspace"
  | "build-failed";

export class PlayableCompilerError extends Error {
  constructor(
    readonly code: PlayableCompilerErrorCode,
    message: string,
    readonly surfaceId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlayableCompilerError";
  }
}

export interface PlayableCompilerOptions {
  minify?: boolean;
  sourcemap?: boolean;
}

export type {
  CompiledPlayableGraph,
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

export async function compilePlayableGraph(
  workspacePath: string,
  graph: PlayableGraph,
  options: PlayableCompilerOptions = {},
): Promise<CompiledPlayableGraph> {
  const validation = validatePlayableGraph(graph);
  if (!validation.ok) {
    const first = validation.issues[0]!;
    throw new PlayableCompilerError(
      "invalid-graph",
      `${first.path}: ${first.message}`,
    );
  }

  const workspaceRoot = await resolveWorkspaceRoot(workspacePath);
  const [entriesResult, shellResult] = await Promise.allSettled([
    mapConcurrent(
      graph.nodes,
      MAX_CONCURRENT_SURFACE_BUILDS,
      async (node): Promise<[string, CompiledPlayableSurface]> => [
        node.id,
        await compileSurface(workspaceRoot, node.id, node.source, options),
      ],
    ),
    graph.shell
      ? compileSurface(workspaceRoot, "shell", graph.shell.source, options)
      : undefined,
  ]);
  if (entriesResult.status === "rejected") throw entriesResult.reason;
  if (shellResult.status === "rejected") throw shellResult.reason;

  return {
    version: 1,
    nodes: Object.fromEntries(entriesResult.value),
    ...(shellResult.value ? { shell: shellResult.value } : {}),
  };
}

async function compileSurface(
  workspaceRoot: string,
  surfaceId: string,
  source: PlayableSource,
  options: PlayableCompilerOptions,
): Promise<CompiledPlayableSurface> {
  const [htmlPath, cssPath, javascriptPath] = await Promise.all([
    resolveSourceFile(workspaceRoot, source.html, surfaceId),
    resolveSourceFile(workspaceRoot, source.css, surfaceId),
    resolveSourceFile(workspaceRoot, source.javascript, surfaceId),
  ]);
  const boundary = workspaceBoundaryPlugin(workspaceRoot, surfaceId);

  try {
    const [html, buildResult] = await Promise.all([
      readFile(htmlPath, "utf8"),
      bundleSurface(
        workspaceRoot,
        cssPath,
        javascriptPath,
        boundary.plugin,
        options,
      ),
    ]);
    const explicitCss = outputText(buildResult, "style.css");
    const importedCss = outputText(buildResult, "script.css", false);
    const javascript = outputText(buildResult, "script.js");
    if (!outputExports(buildResult.metafile, "script.js").includes("mount")) {
      throw new PlayableCompilerError(
        "build-failed",
        `Playable surface "${surfaceId}" JavaScript must export "mount".`,
        surfaceId,
      );
    }
    const inputs = new Set<string>([
      relativePath(workspaceRoot, htmlPath),
      ...metafileInputs(buildResult.metafile),
    ]);

    return {
      id: surfaceId,
      html,
      css: [explicitCss, importedCss].filter(Boolean).join("\n"),
      javascript,
      inputs: [...inputs].sort(),
    };
  } catch (cause) {
    if (boundary.violation) throw boundary.violation;
    if (cause instanceof PlayableCompilerError) throw cause;
    throw new PlayableCompilerError(
      "build-failed",
      `Failed to compile Playable surface "${surfaceId}": ${errorMessage(cause)}`,
      surfaceId,
      { cause },
    );
  }
}

async function bundleSurface(
  workspaceRoot: string,
  cssEntryPoint: string,
  javascriptEntryPoint: string,
  boundary: Plugin,
  options: PlayableCompilerOptions,
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
): { plugin: Plugin; violation?: PlayableCompilerError } {
  const boundary: { plugin: Plugin; violation?: PlayableCompilerError } = {
    plugin: {
      name: "playable-workspace-boundary",
      setup(context) {
        context.onResolve({ filter: /.*/ }, async (args) => {
          if (isBoundaryChecked(args.pluginData)) return;
          const result = await context.resolve(args.path, {
            importer: args.importer,
            kind: args.kind,
            namespace: args.namespace,
            resolveDir: args.resolveDir,
            pluginData: { playableBoundaryChecked: true },
          });
          if (result.errors.length > 0) return result;
          if (result.external) {
            if (args.path.startsWith("data:") || args.path.startsWith("#"))
              return result;
            return {
              errors: [
                {
                  text: `External import "${args.path}" is not allowed in Playable surfaces.`,
                },
              ],
            };
          }
          if (result.namespace !== "file") return result;

          try {
            const resolved = await realpath(result.path);
            assertInsideWorkspace(
              workspaceRoot,
              resolved,
              surfaceId,
              args.path,
            );
          } catch (cause) {
            if (cause instanceof PlayableCompilerError) {
              boundary.violation ??= cause;
              return { errors: [{ text: cause.message }] };
            }
            return {
              errors: [
                {
                  text: `Cannot resolve "${args.path}" inside the project workspace: ${errorMessage(cause)}`,
                },
              ],
            };
          }
          return result;
        });
      },
    },
  };
  return boundary;
}

async function resolveWorkspaceRoot(workspacePath: string): Promise<string> {
  try {
    const root = await realpath(workspacePath);
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
    return root;
  } catch (cause) {
    throw new PlayableCompilerError(
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
    if (!(await stat(resolved)).isFile()) throw new Error("not a file");
    return resolved;
  } catch (cause) {
    if (cause instanceof PlayableCompilerError) throw cause;
    throw new PlayableCompilerError(
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
  throw new PlayableCompilerError(
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

function isBoundaryChecked(pluginData: unknown): boolean {
  return (
    typeof pluginData === "object" &&
    pluginData !== null &&
    Reflect.get(pluginData, "playableBoundaryChecked") === true
  );
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
