import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("./", import.meta.url);

/**
 * The browser helpers a game copies in beside the SDK for the built-in rules it plays,
 * by adapterId. Each module is bundled on its own and has no imports.
 */
export async function builtInGameResources() {
  const [{ build }, ts] = await Promise.all([import("esbuild"), import("typescript")]);
  const source = new URL("src/gomoku-board.ts", root);
  const [bundled, declaration] = await Promise.all([
    build({
      entryPoints: [fileURLToPath(source)],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      // Resolve the SDK from its sources, as the browser SDK build does.
      conditions: ["ohmygame-source"],
      write: false,
    }).then((result) => result.outputFiles[0].text),
    readFile(source, "utf8").then(
      (text) => ts.transpileDeclaration(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    ),
  ]);
  return { gomoku: { "gomoku.js": bundled, "gomoku.d.ts": declaration } };
}
