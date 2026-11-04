import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("./", import.meta.url);
const MODULES = ["index", "errors", "identity", "account", "account-protocol", "cloud", "cloud-protocol", "define-game", "multiplayer-client", "multiplayer-protocol"];

/** The modules client.js carries; multiplayer.js imports them from it instead of bundling a copy. */
const SHARED = new Set(["index", "errors", "identity", "account", "account-protocol", "cloud", "cloud-protocol", "define-game", "multiplayer-protocol"]);

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
  const banner = { js: `/* ${manifest.name} ${manifest.version} */` };
  const bundle = async (entry, options = {}) => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(`src/${entry}.ts`, root))],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      banner,
      write: false,
      ...options,
    });
    return result.outputFiles[0].text;
  };
  // Shared modules resolve to the copy in client.js, so both files use one OhMyGameError class.
  const fromClient = {
    name: "ohmygame-shared-modules",
    setup(build) {
      build.onResolve({ filter: /^\.\/[a-z-]+\.js$/ }, ({ path, importer }) =>
        importer.endsWith("multiplayer-client.ts") && SHARED.has(path.slice(2, -3))
          ? { path: "./client.js", external: true }
          : undefined,
      );
    },
  };
  const declare = async (name) => {
    const source = await readFile(new URL(`src/${name}.ts`, root), "utf8");
    return ts.transpileDeclaration(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, stripInternal: true },
    }).outputText;
  };
  const [esm, multiplayer, iife, defineGame, entry, ...declarations] = await Promise.all([
    bundle("bundle"),
    bundle("multiplayer-client", { plugins: [fromClient] }),
    // Games minify the modules in their own build; the script tag build ships minified.
    bundle("bundle-script", { format: "iife", globalName: "OhMyGame", minify: true }),
    // Rules files import defineGame from this copy; it has no dependencies to load on the service.
    bundle("define-game", { bundle: false }),
    declare("bundle"),
    ...MODULES.map(declare),
  ]);
  return {
    esm,
    multiplayer,
    iife,
    defineGame,
    declarations: {
      "client.d.ts": entry,
      "multiplayer.d.ts": 'export * from "./multiplayer-client.js";\n',
      ...Object.fromEntries(MODULES.map((name, index) => [`${name}.d.ts`, declarations[index]])),
    },
  };
}

/** The files a game receives under src/ohmygame. */
export async function browserSdkResources() {
  const { esm, multiplayer, defineGame, declarations } = await buildBrowserSdk();
  return { "client.js": esm, "multiplayer.js": multiplayer, "define-game.js": defineGame, ...declarations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { esm, multiplayer, iife } = await buildBrowserSdk();
  const directory = new URL("dist/browser/", root);
  await mkdir(directory, { recursive: true });
  // multiplayer.js imports ./client.js, so the two keep these names side by side.
  await Promise.all([
    writeFile(new URL("client.js", directory), esm),
    writeFile(new URL("multiplayer.js", directory), multiplayer),
    writeFile(new URL("ohmygame.iife.js", directory), iife),
  ]);
}
