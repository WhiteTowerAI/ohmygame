/**
 * Records one turn between an installed, signed-in coding agent CLI and its
 * adapter, for the replay tests in test/agent-transcript-replay.test.ts.
 *
 *   node --import tsx scripts/record-agent-transcript.ts claude-code-cli edit [model]
 *
 * Runs in /tmp/ohmygame-transcript, which it empties first, and may use the
 * account's quota. Fields of the person's own setup that the adapters don't
 * read are left out, and the home folder, user name, host name and email
 * addresses are replaced; read the transcript before committing it all the same.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeDriver } from "../src/daemon/agent-runtimes/claude-code.js";
import { CodexDriver } from "../src/daemon/agent-runtimes/codex.js";
import type { DriverContext } from "../src/daemon/agent-runtimes/driver-context.js";
import type { NativeDriver, NativeTurnSink } from "../src/daemon/agent-runtimes/native-session.js";
import { setAgentProcessSpawner, stopAgentProcesses } from "../src/daemon/agent-runtimes/process.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import { FULL_ACCESS_PERMISSION_MODES } from "../src/shared/agent-runtimes.js";
import { recordingSpawner, scrub, serializeTranscript, type TranscriptEntry } from "../test/agent-transcripts.js";

/** The turns the tests replay. Each is short, so recording costs little. */
const SCENARIOS = {
  edit: {
    readOnly: false,
    files: { "hello.txt": "Hello\n" },
    prompt: "In hello.txt, change Hello to Hi with your file editing tool. Then create notes.md containing the single line `done`. Do not run shell commands. Reply with one short sentence when finished.",
  },
  plan: {
    readOnly: true,
    files: { "game.js": "let player = { x: 0 };\nfunction update() {\n  player.x += 1;\n}\n" },
    prompt: "Plan how to add a score counter to game.js that goes up by one each update. Keep the plan to three short steps.",
  },
} as const;

/** Claude Code's built-in tools; others in its list come from the person's plugins and settings. */
const CLAUDE_TOOLS = new Set(["Agent", "AskUserQuestion", "Bash", "BashOutput", "Edit", "EnterPlanMode", "ExitPlanMode", "Glob", "Grep", "KillShell", "MultiEdit", "NotebookEdit", "Read", "Task", "TodoWrite", "WebFetch", "WebSearch", "Write"]);

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

/**
 * Keeps only what the adapters read of the messages that describe the
 * person's setup: their commands, agents, plugins, Skills, MCP servers and
 * account, leaving out the lines about their own MCP servers. The rest of a
 * transcript is the turn itself.
 */
function withoutPersonalSetup(entry: TranscriptEntry): TranscriptEntry[] {
  if (!("line" in entry) || entry.from !== "cli" || !entry.line || typeof entry.line !== "object") return [entry];
  const line = entry.line as Record<string, any>;
  // How the person's own MCP servers start, by name.
  if (line.method === "mcpServer/startupStatus/updated" && !String(line.params?.name).startsWith("ohmygame")) return [];
  if (line.type === "system" && line.subtype === "init")
    return [{ ...entry, line: {
      ...pick(line, ["type", "subtype", "cwd", "session_id", "model", "permissionMode", "apiKeySource", "claude_code_version", "output_style", "uuid"]),
      tools: (line.tools ?? []).filter((tool: string) => CLAUDE_TOOLS.has(tool) || tool.startsWith("mcp__ohmygame")),
      mcp_servers: (line.mcp_servers ?? []).filter((server: { name?: string }) => server.name?.startsWith("ohmygame")),
    } }];
  const response = line.type === "control_response" ? line.response?.response : undefined;
  if (response && typeof response === "object" && "commands" in response)
    return [{ ...entry, line: { ...line, response: { ...line.response, response: pick(response, ["claude_code_version", "current_permission_mode", "output_style", "session_state"]) } } }];
  // Codex's `config/read`: the adapter reads only whether OhMyGame is one of the person's MCP servers.
  if (line.result?.config && line.result?.origins)
    return [{ ...entry, line: { ...line, result: { config: { ...pick(line.result.config, ["model"]), mcp_servers: {} } } } }];
  return [{ ...entry, line: withoutIdentifiers(line) }];
}

const IDENTIFIERS = new Set(["accountId", "account_id", "userId", "user_id", "organizationId", "organization_id", "email"]);

/** Replaces the values of fields that identify the account, wherever they are. */
function withoutIdentifiers(value: unknown): any {
  if (Array.isArray(value)) return value.map(withoutIdentifiers);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, IDENTIFIERS.has(key) && typeof item === "string" ? key.toLowerCase().includes("email") ? "user@example.com" : "redacted" : withoutIdentifiers(item)]));
}

/** The text a streamed piece carries, and where it goes, for the pieces a scrub must see whole. */
function streamedPiece(entry: TranscriptEntry): { stream: string; text: string; set(text: string): TranscriptEntry } | undefined {
  if (!("line" in entry) || entry.from !== "cli" || !entry.line || typeof entry.line !== "object") return undefined;
  const line = entry.line as Record<string, any>;
  const event = line.type === "stream_event" ? line.event : undefined;
  if (event?.type === "content_block_delta") {
    const field = ["text", "thinking", "partial_json"].find((key) => typeof event.delta?.[key] === "string");
    if (!field) return undefined;
    return {
      stream: `${entry.process}:claude:${event.index}:${field}`,
      text: event.delta[field],
      set: (text) => ({ ...entry, line: { ...line, event: { ...event, delta: { ...event.delta, [field]: text } } } }),
    };
  }
  if (typeof line.method === "string" && /delta$/i.test(line.method) && typeof line.params?.delta === "string")
    return {
      stream: `${entry.process}:${line.method}:${line.params.itemId}`,
      text: line.params.delta,
      set: (text) => ({ ...entry, line: { ...line, params: { ...line.params, delta: text } } }),
    };
  return undefined;
}

/**
 * A private value can be split between streamed pieces, where replacing it
 * in each piece misses it. Such a stream is given whole in its first piece,
 * and its other pieces are left empty.
 */
function joinSplitPrivateValues(entries: TranscriptEntry[], isPrivate: (text: string) => boolean): TranscriptEntry[] {
  const streams = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const piece = streamedPiece(entry);
    if (piece) streams.set(piece.stream, [...streams.get(piece.stream) ?? [], index]);
    // A Claude message starts its blocks' indexes again.
    const line = "line" in entry ? entry.line as Record<string, any> : undefined;
    if (line?.type === "stream_event" && line.event?.type === "message_start")
      for (const key of [...streams.keys()]) {
        if (!key.startsWith(`${entry.process}:claude:`) || key.includes("#")) continue;
        streams.set(`${key}#${index}`, streams.get(key)!);
        streams.delete(key);
      }
  });
  const result = [...entries];
  for (const indexes of streams.values()) {
    const pieces = indexes.map((index) => streamedPiece(result[index]!)!);
    const whole = pieces.map((piece) => piece.text).join("");
    if (!isPrivate(whole)) continue;
    indexes.forEach((index, position) => { result[index] = pieces[position]!.set(position === 0 ? whole : ""); });
  }
  return result;
}

const DRIVERS = {
  "claude-code-cli": { binary: "claude", model: "sonnet", usual: "default", create: (context: DriverContext) => new ClaudeCodeDriver(context) },
  "codex-cli": { binary: "codex", model: "", usual: ":workspace", create: (context: DriverContext) => new CodexDriver(context) },
} as const;

const [runtime, scenarioName, modelArgument] = process.argv.slice(2);
if (!(runtime in DRIVERS)) throw new Error(`Choose ${Object.keys(DRIVERS).join(" or ")}`);
if (!(scenarioName in SCENARIOS)) throw new Error(`Choose a scenario: ${Object.keys(SCENARIOS).join(", ")}`);
const driver = DRIVERS[runtime as keyof typeof DRIVERS];
const scenario = SCENARIOS[scenarioName as keyof typeof SCENARIOS];
const model = modelArgument ?? driver.model;
if (!model) throw new Error(`Name the ${runtime} model to record with`);

const binaryPath = execFileSync(process.platform === "win32" ? "where" : "which", [driver.binary], { encoding: "utf8" }).split(/\r?\n/)[0]!.trim();
const version = execFileSync(binaryPath, ["--version"], { encoding: "utf8" }).trim();
// A fixed folder, so the paths in a transcript say nothing about the machine and the replay can use the same ones.
const root = process.platform === "win32" ? path.join(os.tmpdir(), "ohmygame-transcript") : "/tmp/ohmygame-transcript";
await rm(root, { recursive: true, force: true });
const workspacePath = path.join(root, "workspace");
const privateDirectory = path.join(root, "private");
await mkdir(workspacePath, { recursive: true });
await mkdir(privateDirectory);
for (const [file, content] of Object.entries(scenario.files)) await writeFile(path.join(workspacePath, file), content);
execFileSync("git", ["init", "-q"], { cwd: workspacePath });

const permissionMode = scenario.readOnly ? driver.usual : FULL_ACCESS_PERMISSION_MODES[runtime as keyof typeof DRIVERS];
const entries: TranscriptEntry[] = [];
setAgentProcessSpawner(recordingSpawner(spawn, entries));
const native: NativeDriver = driver.create({
  binaryPath,
  workspacePath,
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  privateDirectory,
  instructions: "",
  bridge: new ToolBridge([]),
  permissionMode,
  skillDirectories: [],
  model,
});

const log = (...parts: unknown[]) => console.error(...parts);
const sink: NativeTurnSink = {
  text: () => {},
  textDone: (_key, text) => text && log("text:", text.slice(0, 200)),
  thinking: () => {},
  thinkingDone: () => {},
  toolCall: (callId, name, args) => log("tool:", callId, name, JSON.stringify(args).slice(0, 200)),
  toolStarted: () => {},
  toolUpdate: () => {},
  toolResult: (callId, _result, isError) => log("result:", callId, isError ? "error" : "ok"),
  proposedPlan: (_callId, markdown) => log("plan:", markdown.slice(0, 200)),
  usage: () => {},
  spent: () => {},
  compaction: () => {},
  nativeSession: () => {},
  requestUserInput: async () => { throw new Error("The recorded scenarios ask no questions"); },
  // Recorded with full access, or read-only where the adapter refuses changes itself; anything else asked is declined.
  requestApproval: async (details) => {
    log("approval:", JSON.stringify(details).slice(0, 200));
    return "deny";
  },
};

try {
  const outcome = await native.runTurn({ text: scenario.prompt, images: [], readOnly: scenario.readOnly }, sink, new AbortController().signal);
  log("outcome:", JSON.stringify(outcome));
  if (outcome.status !== "completed") throw new Error("The turn did not complete; nothing was written");
} finally {
  await native.dispose();
  await stopAgentProcesses();
  setAgentProcessSpawner(undefined);
}

const replacements = [
  [os.homedir(), "/home/user"],
  [os.userInfo().username, "user"],
  [os.hostname(), "host"],
] as const;
const header = {
  transcript: 1 as const,
  runtime,
  version,
  scenario: scenarioName,
  model,
  permissionMode,
  readOnly: scenario.readOnly,
  prompt: scenario.prompt,
  workspacePath,
  privateDirectory,
  files: scenario.files,
};
const output = path.resolve("test/fixtures/agent-transcripts", runtime, `${scenarioName}.ndjson`);
await mkdir(path.dirname(output), { recursive: true });
const isPrivate = (text: string) => scrub(text, replacements) !== text;
await writeFile(output, scrub(serializeTranscript({ header, entries: joinSplitPrivateValues(entries.flatMap(withoutPersonalSetup), isPrivate) }), replacements));
await rm(root, { recursive: true, force: true });
console.log(output);
