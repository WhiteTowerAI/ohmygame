import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BuildContext, Plugin } from "esbuild";
import type { GameDefinition, MoveDefinition } from "@ohmygame/sdk/game";
import { isMultiplayerManifestConfig, isRecord, type MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";
import type { BuiltInAdapterId, GameAdapter } from "./adapters.js";
import { compileGame } from "./define-game.js";
import { createMultiplayerServer } from "./service.js";

/** Where a game keeps rules it writes itself, relative to its workspace. */
export const GAME_RULES_FILES = ["server/rules.ts", "server/rules.js", "server/rules.mjs"];
const BUILT_IN_IDS: readonly string[] = ["gomoku", "stones", "arena", "roam"] satisfies BuiltInAdapterId[];

export async function findGameRules(workspace: string): Promise<string | undefined> {
  for (const relative of GAME_RULES_FILES) {
    const file = path.join(workspace, relative);
    if (await access(file).then(() => true, () => false)) return file;
  }
  return undefined;
}

/**
 * Rules import defineGame from @ohmygame/server, @ohmygame/sdk or the game's copy in
 * src/ohmygame/define-game.js; all resolve to the dependency-free module, so a game needs
 * no package installed to load its rules.
 */
function defineGameAlias(): Plugin {
  const own = import.meta.url.endsWith(".ts")
    ? fileURLToPath(new URL("../../sdk/src/define-game.ts", import.meta.url))
    : fileURLToPath(import.meta.resolve("@ohmygame/sdk/game"));
  return {
    name: "ohmygame-define-game",
    setup(build) {
      build.onResolve({ filter: /^@ohmygame\/(server|sdk|sdk\/game)$/ }, () => ({ path: own, namespace: "ohmygame" }));
      // The copy setup puts in a game, which may not exist yet when the rules are first written.
      build.onResolve({ filter: /(^|\/)ohmygame\/define-game(\.js)?$/ }, () => ({ path: own, namespace: "ohmygame" }));
      // Node reads the module, since inside the desktop app it lives in an archive esbuild cannot open.
      build.onLoad({ filter: /.*/, namespace: "ohmygame" }, async () => ({
        contents: await readFile(own, "utf8"),
        loader: own.endsWith(".ts") ? "ts" : "js",
      }));
    },
  };
}

function isGameDefinition(value: unknown): value is GameDefinition<object, Record<string, MoveDefinition<object>>> {
  return isRecord(value) && isRecord(value.players) && typeof value.setup === "function" && isRecord(value.moves);
}

/** Imports one build of the rules; a fresh file each time, since Node caches modules by URL. */
async function importRules(code: string): Promise<GameAdapter> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-rules-"));
  try {
    const file = path.join(directory, "rules.mjs");
    await writeFile(file, code);
    const module: Record<string, unknown> = await import(pathToFileURL(file).href);
    const rules = module.default ?? module.rules;
    if (!isGameDefinition(rules))
      throw new Error("The rules file must export default defineGame({ players, setup, moves }).");
    return compileGame(rules);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function bundleOptions(file: string) {
  return {
    entryPoints: [file],
    bundle: true,
    platform: "node" as const,
    format: "esm" as const,
    target: "node22",
    write: false,
    logLevel: "silent" as const,
    plugins: [defineGameAlias()],
  };
}

/** Bundles a game's rules file with whatever it imports and compiles it for the service. */
export async function loadGameRules(file: string): Promise<GameAdapter> {
  const { build } = await import("esbuild");
  const result = await build(await bundleOptions(file));
  return importRules(result.outputFiles![0]!.text);
}

/** The deployment a local playtest declares in multiplayer.json. */
export async function readLocalDeployment(workspace: string): Promise<MultiplayerManifestConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(workspace, "multiplayer.json"), "utf8"));
  } catch (cause) {
    throw new Error(`Could not read ${path.join(workspace, "multiplayer.json")}.`, { cause });
  }
  const config = isRecord(value) ? value.multiplayer : undefined;
  if (!isMultiplayerManifestConfig(config, { allowLocalhost: true }) || !config.serverUrl.startsWith("http:"))
    throw new Error("multiplayer.json must declare a local HTTP loopback deployment.");
  const endpoint = new URL(config.serverUrl);
  if (!endpoint.port || endpoint.port === "0")
    throw new Error("Choose a fixed local port in multiplayer.json and public/manifest.json.");
  return config;
}

export interface DevServerOptions {
  workspace: string;
  /** Rebuild and restart when the rules or anything they import changes. Defaults to true. */
  watch?: boolean;
  log?: (message: string) => void;
}

/**
 * A local service for one game: its deployment from multiplayer.json, and its own rules
 * from server/rules.ts when it has them. Rooms are in memory and end on restart.
 */
export async function startDevServer(options: DevServerOptions) {
  const log = options.log ?? ((message: string) => console.log(message));
  const config = await readLocalDeployment(options.workspace);
  const rulesFile = await findGameRules(options.workspace);
  const adapterId = config.adapterId ?? (config.mode === "turn-based" ? "stones" : "arena");
  if (rulesFile) {
    if (BUILT_IN_IDS.includes(adapterId))
      throw new Error(`${path.basename(rulesFile)} needs its own adapterId in multiplayer.json; "${adapterId}" is a built-in rule set.`);
    if (config.mode !== "turn-based") throw new Error("Rules written with defineGame are turn-based. Set mode to turn-based.");
  } else if (!BUILT_IN_IDS.includes(adapterId))
    throw new Error(`No rules for "${adapterId}". Write ${GAME_RULES_FILES[0]} with defineGame, or choose a built-in adapterId.`);

  const endpoint = new URL(config.serverUrl);
  const guestSecret = randomBytes(32).toString("hex");
  let service: ReturnType<typeof createMultiplayerServer> | undefined;
  let restarting = Promise.resolve();
  const serve = (adapter?: GameAdapter) =>
    (restarting = restarting.then(async () => {
      await service?.stop();
      service = createMultiplayerServer({
        deployments: [config],
        ...(adapter ? { adapters: { [adapterId]: adapter } } : {}),
        auth: { guestSecret },
        databasePath: ":memory:",
        host: endpoint.hostname === "[::1]" ? "::1" : "127.0.0.1",
        port: Number(endpoint.port),
        allowLocalhost: true,
        logger: false,
      });
      await service.start();
    }));

  let watcher: BuildContext | undefined;
  if (!rulesFile) await serve();
  else if (options.watch === false) await serve(await loadGameRules(rulesFile));
  else {
    const { context } = await import("esbuild");
    let first = true;
    let ready!: (error?: unknown) => void;
    const started = new Promise<void>((resolve, reject) => (ready = (error) => (error ? reject(error) : resolve())));
    const base = await bundleOptions(rulesFile);
    watcher = await context({
      ...base,
      plugins: [
        ...base.plugins,
        {
          name: "ohmygame-restart",
          setup(build) {
            build.onEnd(async (result) => {
              const wasFirst = first;
              first = false;
              try {
                if (result.errors.length)
                  throw new Error(result.errors.map((error) => error.text).join("\n"));
                await serve(await importRules(result.outputFiles![0]!.text));
                if (!wasFirst) log(`Rules reloaded from ${path.relative(options.workspace, rulesFile)}. Rooms restarted.`);
                ready();
              } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                if (wasFirst) ready(cause);
                // A broken edit keeps the last working rules running.
                else log(`The rules did not load; the previous rules keep running.\n${message}`);
              }
            });
          },
        },
      ],
    });
    await watcher.watch();
    await started.catch(async (cause) => {
      await watcher?.dispose();
      throw cause;
    });
  }
  log(`Local Colyseus backend: ${config.serverUrl} (${rulesFile ? path.relative(options.workspace, rulesFile) : adapterId}). Rooms end when this process stops.`);
  return {
    config,
    get port() {
      return service!.port;
    },
    async stop() {
      await watcher?.dispose();
      await restarting;
      await service?.stop();
    },
  };
}
