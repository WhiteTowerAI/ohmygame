import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Only source development builds on demand; packaged apps carry these resources. */
export async function buildMultiplayerSdkResources(): Promise<
  Record<string, string>
> {
  const [{ build }, ts] = await Promise.all([
    import("esbuild"),
    import("typescript"),
  ]);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = await build({
    stdin: {
      contents:
        'export * from "./src/shared/multiplayer-client.ts"; export * from "./src/shared/multiplayer-protocol.ts"; export * from "./src/shared/gomoku.ts";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
  });
  const declarations = await Promise.all(
    ["multiplayer-client", "multiplayer-protocol", "gomoku"].map(
      async (name) => {
        const source = await readFile(
          new URL(`../shared/${name}.ts`, import.meta.url),
          "utf8",
        );
        const { outputText } = ts.transpileDeclaration(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        });
        return [
          `${name}.d.ts`,
          outputText
            .replace(/^import .*from "@colyseus\/sdk";\r?\n/gm, "")
            .replace(/^\s*transport\?:.*\r?\n/gm, ""),
        ];
      },
    ),
  );
  return {
    "client.js": result.outputFiles[0]!.text,
    "client.d.ts":
      'export * from "./multiplayer-client.js"; export * from "./multiplayer-protocol.js"; export * from "./gomoku.js";\n',
    ...Object.fromEntries(declarations),
  };
}

let pending: Promise<Record<string, string>> | undefined;
export function multiplayerSdkResources(): Promise<Record<string, string>> {
  pending ??= import.meta.url.endsWith(".ts")
    ? buildMultiplayerSdkResources()
    : readFile(
        new URL("../multiplayer-sdk/resources.json", import.meta.url),
        "utf8",
      ).then((text) => JSON.parse(text));
  pending.catch(() => {
    pending = undefined;
  });
  return pending;
}
