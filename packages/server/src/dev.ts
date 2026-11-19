import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BuildContext, Plugin } from "esbuild";
import type { GameDefinition, MoveDefinition, RealtimeGameDefinition } from "@ohmygame/game-sdk/game";
import { isMultiplayerManifestConfig, isRecord, type MultiplayerManifestConfig } from "@ohmygame/game-sdk/protocol";
import type { GameAdapter } from "./adapters.js";
import { compileGame } from "./define-game.js";
import { createMultiplayerServer } from "./service.js";

/** Where a game keeps rules it writes itself, relative to its workspace. */
export const GAME_RULES_FILES = ["server/rules.ts", "server/rules.js", "server/rules.mjs"];

export async function findGameRules(workspace: string): Promise<string | undefined> {
  for (const relative of GAME_RULES_FILES) {
    const file = path.join(workspace, relative);
    if (await access(file).then(() => true, () => false)) return file;
  }
  return undefined;
}

/**
 * Rules import defineGame from @ohmygame/server, @ohmygame/game-sdk or the game's copy in
 * src/ohmygame/define-game.js; all resolve to the dependency-free module, so a game needs
 * no package installed to load its rules.
 */
function defineGameAlias(): Plugin {
  const own = import.meta.url.endsWith(".ts")
    ? fileURLToPath(new URL("../../game-sdk/src/define-game.ts", import.meta.url))
    : fileURLToPath(import.meta.resolve("@ohmygame/game-sdk/game"));
  return {
    name: "ohmygame-define-game",
    setup(build) {
      build.onResolve({ filter: /^@ohmygame\/(server|game-sdk|game-sdk\/game)$/ }, () => ({ path: own, namespace: "ohmygame" }));
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

type AnyRules = GameDefinition<object, Record<string, MoveDefinition<object>>> | RealtimeGameDefinition<object, object>;

/** Turn-based rules have moves; realtime rules have tick and input. */
function isRules(value: unknown): value is AnyRules {
  return isRecord(value) && isRecord(value.players) && typeof value.setup === "function" &&
    (isRecord(value.moves) || (typeof value.tick === "function" && typeof value.input === "function"));
}

/** Imports one build of the rules; a fresh file each time, since Node caches modules by URL. */
async function importRules(code: string): Promise<AnyRules> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-rules-"));
  try {
    const file = path.join(directory, "rules.mjs");
    await writeFile(file, code);
    const module: Record<string, unknown> = await import(pathToFileURL(file).href);
    const rules = module.default ?? module.rules;
    if (!isRules(rules))
      throw new Error(
        "The rules file must export default defineGame({ players, setup, moves }) for a turn-based game, or defineRealtimeGame({ players, setup, input, tick }) for a realtime one.",
      );
    return rules;
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
  return compileGame(await loadRulesDefinition(file));
}

/** The rules a game's rules file exports, as defineGame or defineRealtimeGame returned them. */
export async function loadRulesDefinition(file: string): Promise<AnyRules> {
  const { build } = await import("esbuild");
  const result = await build(await bundleOptions(file));
  return importRules(result.outputFiles![0]!.text);
}

/** What a host needs to know of a game's rules without running them. */
export interface GameRulesSummary {
  mode: GameAdapter["mode"];
  players: { min: number; max: number };
  tickMs?: number;
  /** Whether each player sees only their own view of the game. */
  playerView: boolean;
}

/** How long a rules file may take to load before it is given up. */
export const RULES_INSPECT_TIMEOUT_MS = 10_000;

/**
 * Reads the shape of the rules in a worker: the game's top-level code never runs in the
 * caller, a hang is cut off, and the module and its timers end with the worker.
 */
const INSPECT_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.url).then((module) => {
  const rules = module.default ?? module.rules;
  const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const fn = (value) => typeof value === "function";
  if (!isRecord(rules) || !isRecord(rules.players) || !fn(rules.setup) || !(isRecord(rules.moves) || (fn(rules.tick) && fn(rules.input))))
    return parentPort.postMessage({ invalid: true });
  const realtime = !isRecord(rules.moves) || fn(rules.tick);
  parentPort.postMessage({ shape: {
    realtime,
    players: { min: rules.players.min, max: rules.players.max },
    tickMs: rules.tickMs,
    turnSeconds: rules.turnSeconds,
    action: rules.action === undefined ? undefined : fn(rules.action),
    playerView: fn(rules.playerView),
  } });
}, (error) => parentPort.postMessage({ error: String(error && error.stack || error) }));
`;

interface RulesShape {
  realtime: boolean;
  players: { min: unknown; max: unknown };
  tickMs?: unknown;
  turnSeconds?: unknown;
  action?: boolean;
  playerView: boolean;
}

async function inspectRules(code: string, timeoutMs: number): Promise<RulesShape> {
  const { Worker } = await import("node:worker_threads");
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-rules-"));
  try {
    const file = path.join(directory, "rules.mjs");
    await writeFile(file, code);
    const worker = new Worker(INSPECT_WORKER, {
      eval: true,
      workerData: { url: pathToFileURL(file).href },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: true,
      stderr: true,
    });
    try {
      const message = await new Promise<{ shape?: RulesShape; invalid?: boolean; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`The rules file took longer than ${timeoutMs / 1000} seconds to load. Check its top-level code for a loop that never ends.`)), timeoutMs);
        worker.once("message", (value) => { clearTimeout(timer); resolve(value); });
        worker.once("error", (error) => { clearTimeout(timer); reject(error); });
        worker.once("exit", (code) => { clearTimeout(timer); reject(new Error(`The rules file stopped while loading (exit ${code}).`)); });
      });
      if (message.error) throw new Error(`The rules file failed to load: ${message.error}`);
      if (message.invalid || !message.shape)
        throw new Error(
          "The rules file must export default defineGame({ players, setup, moves }) for a turn-based game, or defineRealtimeGame({ players, setup, input, tick }) for a realtime one.",
        );
      return message.shape;
    } finally {
      await worker.terminate();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Summaries by the bundled rules' hash, so loading the same rules again runs nothing. */
const inspected = new Map<string, Promise<GameRulesSummary>>();
const INSPECTED_MAX = 32;

/**
 * Checks a game's rules file and reads its mode, seats and tick, as compileGame would,
 * without running the rules in this process.
 */
export async function inspectGameRules(file: string, timeoutMs = RULES_INSPECT_TIMEOUT_MS): Promise<GameRulesSummary> {
  const { build } = await import("esbuild");
  const code = (await build(await bundleOptions(file))).outputFiles![0]!.text;
  const key = createHash("sha256").update(code).digest("hex");
  let summary = inspected.get(key);
  if (!summary) {
    summary = inspectRules(code, timeoutMs).then(summarize);
    inspected.set(key, summary);
    // A failed load is tried again next time; the file may be fixed by then.
    summary.catch(() => inspected.delete(key));
    if (inspected.size > INSPECTED_MAX) inspected.delete(inspected.keys().next().value!);
  }
  return summary;
}

/** Where a game keeps tests of its own rules, relative to its workspace. */
export const GAME_RULES_TEST_FILE = "server/rules.test.ts";
/** How long a game's rules tests may run, all together, before they are given up. */
export const RULES_TEST_TIMEOUT_MS = 30_000;

/** One test of a game's rules and how it went. */
export interface RulesTestOutcome {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface RulesTestRun {
  results: RulesTestOutcome[];
  /** The test still running when time ran out; the tests after it did not run. */
  timedOut?: string;
}

/**
 * Runs a test file of a game's rules in a worker. The file registers tests with test()
 * from the game's src/ohmygame/testing.js, which, seeing the registry this sets, leaves the
 * running to the worker. A test that never ends is cut off with the rest.
 */
const TEST_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
globalThis.__OHMYGAME_RULES_TESTS__ = { tests: [] };
let current;
process.on("unhandledRejection", (error) => parentPort.postMessage({ stray: current, error: String(error && error.message || error) }));
import(workerData.url).then(async () => {
  for (const { name, run } of globalThis.__OHMYGAME_RULES_TESTS__.tests) {
    current = name;
    parentPort.postMessage({ start: name });
    const started = Date.now();
    try {
      await run();
      parentPort.postMessage({ done: { name, ok: true, ms: Date.now() - started } });
    } catch (error) {
      parentPort.postMessage({ done: { name, ok: false, error: String(error && error.message || error), ms: Date.now() - started } });
    }
  }
  parentPort.postMessage({ finished: true });
}, (error) => parentPort.postMessage({ error: String(error && error.stack || error) }));
`;

/** Bundles a test file of a game's rules with what it imports and runs its tests in a worker. */
export async function runGameRulesTests(file: string, timeoutMs = RULES_TEST_TIMEOUT_MS): Promise<RulesTestRun> {
  const { build } = await import("esbuild");
  let code: string;
  try {
    code = (await build(await bundleOptions(file))).outputFiles![0]!.text;
  } catch (cause) {
    const errors = (cause as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors;
    const detail = errors?.length
      ? errors.slice(0, 5).map((error) => `${error.location ? `${error.location.file}:${error.location.line}: ` : ""}${error.text}`).join("\n")
      : String(cause);
    throw new Error(`The test file did not build:\n${detail}`);
  }
  const { Worker } = await import("node:worker_threads");
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-rules-test-"));
  try {
    const bundled = path.join(directory, "rules.test.mjs");
    await writeFile(bundled, code);
    const worker = new Worker(TEST_WORKER, {
      eval: true,
      workerData: { url: pathToFileURL(bundled).href },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      stdout: true,
      stderr: true,
    });
    let running: string | undefined;
    const done: RulesTestOutcome[] = [];
    const strays = new Map<string, string>();
    try {
      const finished = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        worker.on("message", (message: { start?: string; done?: RulesTestOutcome; finished?: boolean; stray?: string; error?: string }) => {
          if (message.start !== undefined) running = message.start;
          else if (message.done) {
            done.push(message.done);
            running = undefined;
          } else if (message.finished) {
            clearTimeout(timer);
            resolve(true);
          } else if (message.error !== undefined && "stray" in message) {
            // A promise a test left behind failed after it: it counts against that test.
            if (message.stray) strays.set(message.stray, message.error);
          } else if (message.error !== undefined) {
            clearTimeout(timer);
            reject(new Error(`The test file failed to load: ${message.error}`));
          }
        });
        worker.once("error", (error) => { clearTimeout(timer); reject(error); });
        worker.once("exit", (code) => { clearTimeout(timer); reject(new Error(`The tests stopped (exit ${code}).`)); });
      });
      if (!finished && running === undefined && !done.length)
        throw new Error(`The test file took longer than ${timeoutMs / 1000} seconds to load. Check its top-level code, and the rules', for a loop that never ends.`);
      return {
        ...(!finished && running !== undefined ? { timedOut: running } : {}),
        results: done.map((result) => {
          const stray = strays.get(result.name);
          return result.ok && stray ? { ...result, ok: false, error: `It left a promise that failed: ${stray}` } : result;
        }),
      };
    } finally {
      await worker.terminate();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Compiles stand-ins with the rules' own settings, so they are checked exactly as compileGame checks them. */
function summarize(shape: RulesShape): GameRulesSummary {
  const players = shape.players as { min: number; max: number };
  const stub = () => ({});
  const view = shape.playerView ? { playerView: stub } : {};
  const adapter = shape.realtime
    ? compileGame({
        players,
        setup: stub,
        tick: stub,
        input: stub,
        ...(shape.tickMs === undefined ? {} : { tickMs: shape.tickMs as number }),
        ...(shape.action === undefined ? {} : { action: shape.action ? stub : (null as never) }),
        ...view,
      })
    : compileGame({
        players,
        setup: stub,
        moves: {},
        ...(shape.turnSeconds === undefined ? {} : { turnSeconds: shape.turnSeconds as number }),
        ...view,
      });
  return {
    mode: adapter.mode,
    players: { ...adapter.players },
    ...(adapter.tickMs === undefined ? {} : { tickMs: adapter.tickMs }),
    playerView: shape.playerView,
  };
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
  /** Rules registered by adapterId, for games without their own rules file. */
  adapters?: Record<string, GameAdapter>;
}

/**
 * A local service for one game: its deployment from multiplayer.json, and its own rules
 * from server/rules.ts when it has them. Rooms are in memory and end on restart.
 */
export async function startDevServer(options: DevServerOptions) {
  const log = options.log ?? ((message: string) => console.log(message));
  const config = await readLocalDeployment(options.workspace);
  const rulesFile = await findGameRules(options.workspace);
  const registered = options.adapters ?? {};
  const { adapterId } = config;
  if (rulesFile) {
    if (Object.hasOwn(registered, adapterId))
      throw new Error(`${path.basename(rulesFile)} needs its own adapterId in multiplayer.json; "${adapterId}" is already registered.`);
  } else if (!Object.hasOwn(registered, adapterId))
    throw new Error(`No rules for "${adapterId}". Write ${GAME_RULES_FILES[0]} with defineGame.`);

  const endpoint = new URL(config.serverUrl);
  const guestSecret = randomBytes(32).toString("hex");
  let service: ReturnType<typeof createMultiplayerServer> | undefined;
  let restarting = Promise.resolve();
  const serve = (adapter?: GameAdapter) =>
    (restarting = restarting.then(async () => {
      await service?.stop();
      service = createMultiplayerServer({
        deployments: [config],
        adapters: adapter ? { ...registered, [adapterId]: adapter } : registered,
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
                await serve(compileGame(await importRules(result.outputFiles![0]!.text)));
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
