/**
 * Recorded conversations between a coding agent's CLI and its adapter, and a
 * fake CLI that plays one back. `scripts/record-agent-transcript.ts` records
 * them against the installed CLI; the driver tests replay them, so a change to
 * an adapter is checked against what the CLI really sends.
 */
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import readline from "node:readline";

/** The first line of a transcript file. */
export interface TranscriptHeader {
  transcript: 1;
  runtime: string;
  /** The CLI's `--version` output when it was recorded. */
  version: string;
  scenario: string;
  model: string;
  permissionMode: string;
  readOnly: boolean;
  prompt: string;
  /** Where the turn ran; a replay gives the adapter the same folders. */
  workspacePath: string;
  privateDirectory: string;
  /** Files the workspace held before the turn, by path relative to it. */
  files: Record<string, string>;
}

/**
 * One line of a CLI's stdout (`cli`), one line the adapter wrote to its stdin
 * (`adapter`), or the CLI's exit. `process` counts the CLIs the turn started.
 */
export type TranscriptEntry =
  | { process: number; from: "cli" | "adapter"; line: unknown }
  | { process: number; from: "cli"; exit: number | null };

export interface Transcript {
  header: TranscriptHeader;
  entries: TranscriptEntry[];
}

export async function readTranscript(file: string): Promise<Transcript> {
  const [header, ...entries] = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (header?.transcript !== 1) throw new Error(`${file} is not a transcript`);
  return { header: header as TranscriptHeader, entries: entries as TranscriptEntry[] };
}

export function serializeTranscript(transcript: Transcript): string {
  return [transcript.header, ...transcript.entries].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Wraps the real spawner so every line between the adapter and the CLI is
 * added to `entries`. The CLI runs as usual.
 */
export function recordingSpawner(real: typeof spawn, entries: TranscriptEntry[]): typeof spawn {
  let count = 0;
  return ((file: string, args: readonly string[], options: object) => {
    const process = ++count;
    const child = real(file, args, options as never);
    if (child.stdout) readline.createInterface({ input: child.stdout }).on("line", (line) => entries.push({ process, from: "cli", line: parsed(line) }));
    const stdin = child.stdin;
    if (stdin) {
      let pending = "";
      const write = stdin.write.bind(stdin) as (...args: unknown[]) => boolean;
      stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
        pending += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          entries.push({ process, from: "adapter", line: parsed(pending.slice(0, end)) });
          pending = pending.slice(end + 1);
        }
        return write(chunk, ...rest);
      }) as typeof stdin.write;
    }
    child.on("close", (code: number | null) => entries.push({ process, from: "cli", exit: code }));
    return child;
  }) as typeof spawn;
}

/** Replaces each private value with a stand-in, longest first so a path is replaced before its parent. */
export function scrub(text: string, replacements: ReadonlyArray<readonly [string, string]>): string {
  let result = text;
  for (const [value, replacement] of [...replacements].filter(([value]) => value.length > 0).sort(([a], [b]) => b.length - a.length))
    result = result.split(value).join(replacement);
  return result.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "user@example.com");
}

/**
 * What identifies a line the adapter writes: its protocol message kind, with
 * none of the values that change between runs, such as ids and paths.
 */
export function lineKind(line: unknown): string {
  if (!line || typeof line !== "object") return "text";
  const value = line as Record<string, any>;
  // JSON-RPC (Codex): a request or notification by method, a reply as such.
  if (typeof value.method === "string") return `method:${value.method}`;
  if ("result" in value || "error" in value) return "reply";
  // Claude Code's stream-json.
  if (value.type === "control_request") return `control_request:${value.request?.subtype}`;
  if (value.type === "control_response") return `control_response:${value.response?.subtype}`;
  return `type:${value.type}`;
}

/** The id an adapter's request carries, which the CLI's reply names. */
function requestId(line: unknown): string | number | undefined {
  if (!line || typeof line !== "object") return undefined;
  const value = line as Record<string, any>;
  if (value.type === "control_request" && typeof value.request_id === "string") return value.request_id;
  if (typeof value.method === "string" && (typeof value.id === "string" || typeof value.id === "number")) return value.id;
  return undefined;
}

/** Gives a recorded reply the id of the request the adapter actually sent. */
function withRequestIds(line: unknown, ids: Map<string | number, string | number>): unknown {
  if (!line || typeof line !== "object") return line;
  const value = line as Record<string, any>;
  if (value.type === "control_response" && ids.has(value.response?.request_id))
    return { ...value, response: { ...value.response, request_id: ids.get(value.response.request_id) } };
  if (typeof value.method !== "string" && ("result" in value || "error" in value) && ids.has(value.id))
    return { ...value, id: ids.get(value.id) };
  return line;
}

export interface Replay {
  /** What the adapter wrote that the transcript did not expect; a test expects none. */
  unexpected: string[];
  /** Adapter lines the transcript has and the adapter never wrote. */
  missing(): string[];
}

/**
 * Plays a transcript back as the CLI. Each spawned process gets the lines of
 * the process with the same number. The CLI's lines are sent in order up to the
 * next line the adapter wrote when it was recorded, and the rest wait until the
 * adapter writes a line of that kind. Lines the adapter writes earlier than
 * recorded are matched with the next recorded line of their kind, and a
 * recorded line it skips is reported by `missing`.
 */
export function replaySpawner(transcript: Transcript, setSpawner: (spawner: typeof spawn | undefined) => void): Replay {
  const unexpected: string[] = [];
  const consumed = new Set<TranscriptEntry>();
  let count = 0;
  setSpawner(((_file: string, _args: readonly string[]) => {
    const process = ++count;
    const entries = transcript.entries.filter((entry) => entry.process === process);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, pid: undefined, exitCode: null, signalCode: null, killed: false, kill: () => true });
    const ids = new Map<string | number, string | number>();
    let position = 0;
    let sending = false;
    const exit = (code: number | null) => {
      if (child.exitCode !== null) return;
      child.exitCode = code ?? 0;
      stdout.end();
      child.emit("close", code, null);
    };
    // Sends the CLI's lines up to the next one the adapter has yet to write, a line per tick as a stream would.
    const send = () => {
      if (sending) return;
      sending = true;
      const step = () => {
        // A line the adapter no longer writes is passed once it has written one recorded after it; `missing` names it.
        const passed = entries.findLastIndex((entry) => entry.from === "adapter" && consumed.has(entry));
        while (position < entries.length && (consumed.has(entries[position]!) || (entries[position]!.from === "adapter" && position < passed))) position += 1;
        const entry = entries[position];
        if (!entry || entry.from === "adapter" || child.exitCode !== null) {
          sending = false;
          return;
        }
        position += 1;
        if ("exit" in entry) exit(entry.exit);
        else stdout.write(`${typeof entry.line === "string" ? entry.line : JSON.stringify(withRequestIds(entry.line, ids))}\n`);
        setImmediate(step);
      };
      setImmediate(step);
    };
    readline.createInterface({ input: stdin }).on("line", (text) => {
      const line = parsed(text);
      const kind = lineKind(line);
      const match = entries.find((entry, index) => index >= position - 1 && entry.from === "adapter" && !consumed.has(entry) && "line" in entry && lineKind(entry.line) === kind)
        ?? entries.find((entry) => entry.from === "adapter" && !consumed.has(entry) && "line" in entry && lineKind(entry.line) === kind);
      if (!match || !("line" in match)) {
        unexpected.push(`process ${process}: ${kind}`);
        return;
      }
      consumed.add(match);
      const recorded = requestId(match.line);
      const actual = requestId(line);
      if (recorded !== undefined && actual !== undefined) ids.set(recorded, actual);
      send();
    });
    stdin.on("finish", () => exit(0));
    send();
    return child;
  }) as never);
  return {
    unexpected,
    missing: () => transcript.entries.flatMap((entry) =>
      entry.from === "adapter" && !consumed.has(entry) && "line" in entry ? [`process ${entry.process}: ${lineKind(entry.line)}`] : []),
  };
}
