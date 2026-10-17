import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

/** Where a web story project keeps its runtime, and the module its page loads. */
export const STORY_WEB_DIRECTORY = "story";
export const STORY_WEB_ENTRY = "story/story-web/runtime.js";

let bridge: Promise<string> | undefined;
let modules: Promise<Record<string, string>> | undefined;

/** The editor bridge the preview injects into a web story's pages, as one classic script. */
export function storyWebEditorBridge(): Promise<string> {
  bridge ??= (async () => {
    const result = await build({
      entryPoints: [await sourceFile("story-web/editor-bridge")],
      bundle: true,
      format: "iife",
      target: "es2022",
      write: false,
      legalComments: "none",
    });
    return result.outputFiles[0]!.text;
  })();
  bridge.catch(() => { bridge = undefined; });
  return bridge;
}

/**
 * The story runtime a web story project carries, as readable modules keyed by
 * their path in the project: each is one OhMyGame source file with its types
 * removed, so the Agent can read and change it like any project code.
 */
export function storyWebRuntimeModules(): Promise<Record<string, string>> {
  modules ??= (async () => {
    const entry = await sourceFile("story-web/runtime");
    const sourceRoot = path.dirname(path.dirname(entry));
    const { metafile } = await build({ entryPoints: [entry], bundle: true, format: "esm", write: false, metafile: true });
    const files: Record<string, string> = {};
    for (const input of Object.keys(metafile.inputs)) {
      const absolute = path.resolve(input);
      const relative = path.relative(sourceRoot, absolute).replace(/\.ts$/, ".js").split(path.sep).join("/");
      files[`${STORY_WEB_DIRECTORY}/${relative}`] = await readableModule(absolute);
    }
    return files;
  })();
  modules.catch(() => { modules = undefined; });
  return modules;
}

/**
 * A module with its comments, which explain the runtime to whoever changes
 * it. A build already holds it compiled by tsc; in development TypeScript
 * strips the types, falling back to esbuild, which drops comments.
 */
async function readableModule(file: string): Promise<string> {
  const source = await readFile(file, "utf8");
  if (!file.endsWith(".ts")) return source.replace(/\n\/\/# sourceMappingURL=.*\s*$/, "\n");
  try {
    const { default: ts } = await import("typescript");
    return ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  } catch {
    return (await transform(source, { loader: "ts", format: "esm", target: "es2022" })).code;
  }
}

/** Source in development, the compiled module in a build. */
async function sourceFile(name: string): Promise<string> {
  for (const extension of [".ts", ".js"]) {
    // Built from the module's own path, not the global URL, which test DOMs replace.
    const candidate = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", `${name}${extension}`);
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`The web story module ${name} is missing from this build.`);
}
