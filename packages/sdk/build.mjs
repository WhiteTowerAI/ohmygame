import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("./", import.meta.url);
const MODULES = ["index", "errors", "identity", "define-game", "multiplayer-client", "multiplayer-protocol", "gomoku"];

/**
 * Bundles the browser SDK with its dependencies from the package sources. Test-only
 * options are marked @internal and stay out of the declarations.
 */
export async function buildBrowserSdk() {
  const [{ build }, ts, manifest] = await Promise.all([
    import("esbuild"),
    import("typescript"),
    readFile(new URL("package.json", root), "utf8").then(JSON.parse),
  ]);
  const bundle = async (format) => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("src/bundle.ts", root))],
      bundle: true,
      platform: "browser",
      format,
      // Games minify the module in their own build; the script tag build ships minified.
      ...(format === "iife" ? { globalName: "OhMyGame", minify: true } : {}),
      target: "es2022",
      banner: { js: `/* ${manifest.name} ${manifest.version} */` },
      write: false,
    });
    return result.outputFiles[0].text;
  };
  const declare = async (name) => {
    const source = await readFile(new URL(`src/${name}.ts`, root), "utf8");
    return ts.transpileDeclaration(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, stripInternal: true },
    }).outputText;
  };
  // Rules files import defineGame from this copy; it has no dependencies to load on the service.
  const defineGame = (async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("src/define-game.ts", root))],
      format: "esm",
      target: "es2022",
      banner: { js: `/* ${manifest.name} ${manifest.version} */` },
      write: false,
    });
    return result.outputFiles[0].text;
  })();
  const [esm, iife, defineGameModule, entry, ...declarations] = await Promise.all([
    bundle("esm"),
    bundle("iife"),
    defineGame,
    declare("bundle"),
    ...MODULES.map(declare),
  ]);
  return {
    esm,
    iife,
    defineGame: defineGameModule,
    declarations: {
      "client.d.ts": entry,
      ...Object.fromEntries(MODULES.map((name, index) => [`${name}.d.ts`, declarations[index]])),
    },
  };
}

/** The files a game receives under src/ohmygame. */
export async function browserSdkResources() {
  const { esm, defineGame, declarations } = await buildBrowserSdk();
  return { "client.js": esm, "define-game.js": defineGame, ...declarations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { esm, iife } = await buildBrowserSdk();
  const directory = new URL("dist/browser/", root);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(new URL("ohmygame.js", directory), esm),
    writeFile(new URL("ohmygame.iife.js", directory), iife),
  ]);
}
