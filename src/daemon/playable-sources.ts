import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { build, type BuildFailure, type Message, type Metafile, type Plugin } from "esbuild";
import type { NodeGraph, NodeSource, PlayableNode } from "../shared/playable-nodes.js";
import { playableBackdropClipError } from "../shared/playable-backdrop.js";

/**
 * Checks each Scene's files the way the story's page will load them, without
 * building anything: the page loads them as they are. A Scene's HTML, CSS,
 * and JavaScript must be project files; its module must parse and export
 * `mount`; and what it imports must be something a browser can import.
 */

export type PlayableSourceIssueCode =
  | "missing-source"
  | "path-outside-workspace"
  | "invalid-source"
  | "invalid-video-clip"
  | "resource-limit";

/** The first problem found in one Scene's files. */
export interface PlayableSourceIssue {
  code: PlayableSourceIssueCode;
  surfaceId: string;
  message: string;
}

export interface PlayableSourceCheck {
  issues: PlayableSourceIssue[];
  /**
   * What each Scene shows, by content: its files and everything they import,
   * its declared Assets, and the viewport. A Scene with an issue has none.
   */
  hashes: Record<string, string>;
}

const MAX_CONCURRENT_CHECKS = 4;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
/** Modules a page imports as code; JSON needs its import attribute, and anything else is fetched. */
const MODULE_EXTENSIONS = new Set([".js", ".mjs"]);

class SourceProblem extends Error {
  constructor(readonly code: PlayableSourceIssueCode, message: string) {
    super(message);
  }
}

export async function checkPlayableSources(workspacePath: string, graph: NodeGraph): Promise<PlayableSourceCheck> {
  const root = await realpath(workspacePath);
  const results = await mapConcurrent(graph.nodes, MAX_CONCURRENT_CHECKS, async (node) => {
    try {
      return { node, hash: await checkScene(root, graph, node) };
    } catch (cause) {
      if (!(cause instanceof SourceProblem)) throw cause;
      return { node, issue: { code: cause.code, surfaceId: node.id, message: cause.message } };
    }
  });
  return {
    issues: results.flatMap((result) => result.issue ? [result.issue] : []),
    hashes: Object.fromEntries(results.flatMap((result) => result.hash ? [[result.node.id, result.hash]] : [])),
  };
}

async function checkScene(root: string, graph: NodeGraph, node: PlayableNode): Promise<string> {
  const files = await sourceFiles(root, node.source);
  const html = await readFile(files.html, "utf8");
  const clipError = playableBackdropClipError(html);
  if (clipError) throw new SourceProblem("invalid-video-clip", `${node.source.html}: ${clipError}`);

  const used = new Set<string>([files.html, files.css, files.javascript]);
  const script = await analyze(root, files.javascript, used);
  if (!exports(script).includes("mount")) {
    throw new SourceProblem("invalid-source", `${node.source.javascript} must export a mount function.`);
  }
  await analyze(root, files.css, used);

  const hash = createHash("sha256");
  for (const file of [...used].sort()) {
    hash.update(path.relative(root, file)).update("\0").update(await readFile(file)).update("\0");
  }
  const assets = [...node.assets].sort().map((id) => [id, graph.assets[id] ?? null]);
  hash.update(JSON.stringify({ assets, viewport: graph.viewport }));
  return hash.digest("hex").slice(0, 32);
}

async function sourceFiles(root: string, source: NodeSource): Promise<NodeSource> {
  const [html, css, javascript] = await Promise.all(
    [source.html, source.css, source.javascript].map((relative) => projectFile(root, relative, relative)),
  );
  return { html: html!, css: css!, javascript: javascript! };
}

/** The real path of a project file, refused when it is missing, outside the project, or too large. */
async function projectFile(root: string, candidate: string, named: string): Promise<string> {
  const absolute = path.resolve(root, ...candidate.split("/"));
  assertInside(root, absolute, named);
  let resolved: string;
  try {
    resolved = await realpath(absolute);
    if (!(await stat(resolved)).isFile()) throw new Error("not a file");
  } catch {
    throw new SourceProblem("missing-source", `"${named}" is missing from the project.`);
  }
  assertInside(root, resolved, named);
  if ((await stat(resolved)).size > MAX_SOURCE_BYTES) {
    throw new SourceProblem("resource-limit", `"${named}" is larger than 5 MiB.`);
  }
  return resolved;
}

function assertInside(root: string, target: string, named: string): void {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new SourceProblem("path-outside-workspace", `"${named}" is outside the project.`);
}

/**
 * Parses an entry and what it imports, following imports as the page will.
 * Every project file it reaches is added to `used`.
 */
async function analyze(root: string, entry: string, used: Set<string>): Promise<Metafile> {
  const problem: { first?: SourceProblem } = {};
  try {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      outdir: ".playable-check",
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      plugins: [browserImports(root, used, problem)],
    });
    return result.metafile;
  } catch (cause) {
    if (problem.first) throw problem.first;
    const message = (cause as BuildFailure).errors?.[0];
    if (!message) throw cause;
    throw new SourceProblem("invalid-source", describe(root, message));
  }
}

/** Resolves imports as a browser would: by URL, never from packages. */
function browserImports(root: string, used: Set<string>, problem: { first?: SourceProblem }): Plugin {
  const refuse = (cause: SourceProblem) => {
    problem.first ??= cause;
    return { errors: [{ text: cause.message }] };
  };
  return {
    name: "playable-browser-imports",
    setup(context) {
      context.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point") return undefined;
        const specifier = args.path;
        // Images and fonts a stylesheet names load when shown; a missing one does not stop the Scene.
        if (args.kind === "url-token" || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(specifier)) return { path: specifier, external: true };
        const importer = path.relative(root, args.importer).split(path.sep).join("/");
        // A stylesheet's @import is a URL, relative to the stylesheet unless it starts with /.
        const stylesheet = args.kind === "import-rule";
        if (!stylesheet && !/^\.{0,2}\//.test(specifier)) {
          return refuse(new SourceProblem("invalid-source", `${importer} imports "${specifier}", but a story's page has no packages. Copy the module into the project and import it by a relative path.`));
        }
        const relativeToRoot = specifier.startsWith("/")
          ? specifier.slice(1)
          : path.relative(root, path.resolve(args.resolveDir, specifier.replace(/[?#].*$/, "")));
        let file: string;
        try {
          file = await projectFile(root, relativeToRoot.split(path.sep).join("/"), `${specifier}" imported by "${importer}`);
        } catch (cause) {
          if (cause instanceof SourceProblem) return refuse(cause);
          throw cause;
        }
        used.add(file);
        const extension = path.extname(file).toLowerCase();
        if (args.kind === "import-rule" || MODULE_EXTENSIONS.has(extension)) return { path: file };
        if (extension === ".json" && args.with.type === "json") return { path: file, external: true };
        if (extension === ".css" && args.with.type === "css") return { path: file, external: true };
        const hint = extension === ".json"
          ? `add with { type: "json" } to the import`
          : `load it with fetch(new URL("${specifier}", import.meta.url)) instead`;
        return refuse(new SourceProblem("invalid-source", `${importer} imports "${specifier}", which a browser cannot import as a module; ${hint}.`));
      });
    },
  };
}

function exports(metafile: Metafile): string[] {
  return Object.values(metafile.outputs).flatMap((output) => output.exports);
}

function describe(root: string, message: Message): string {
  const location = message.location;
  if (!location) return message.text;
  const file = path.relative(root, path.resolve(root, location.file)).split(path.sep).join("/");
  return `${file}:${location.line}:${location.column + 1}: ${message.text}`;
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, transform: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await transform(values[index]!);
    }
  }));
  return results;
}
