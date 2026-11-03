import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import type { ProjectState } from "../shared/contracts.js";
import {
  localDate,
  type UsageRow,
  type UsageStats,
} from "../shared/usage-stats.js";
import {
  NATIVE_USAGE_ENTRY,
  type StoredNativeUsage,
} from "./agent-runtimes/native-session.js";
import { NATIVE_API } from "./agent-runtimes/replay.js";
import { sessionDirectory } from "./conversations.js";

/** Tokens one response, request or turn spent, as its session file recorded them. */
interface TokenRecord {
  kind: "tokens";
  /** The same record copied into a branched conversation has the same key. */
  key: string;
  date: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A turn: from a person's message to the last thing the agent did for it. */
interface TurnRecord {
  kind: "turn";
  key: string;
  date: string;
  provider: string;
  model: string;
  durationMs: number;
}

type UsageRecord = TokenRecord | TurnRecord;

interface OpenTurn {
  key: string;
  date: string;
  last: number;
  durationMs: number;
  provider?: string;
  model?: string;
}

interface FileUsage {
  inode: number;
  mtimeMs: number;
  size: number;
  /** Bytes read up to the end of the last whole line. */
  offset: number;
  /** The bytes just before `offset`, to tell an append from a rewrite. */
  tail: Buffer;
  records: UsageRecord[];
  /** The latest turn, which may still be running or gain entries. */
  turn?: OpenTurn;
}

const FILES_PER_BATCH = 4;
const TAIL_BYTES = 64;
const CHUNK_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 400;
/** A longer pause in a turn is waiting, such as for an approval, not work. */
const IDLE_GAP_MS = 15 * 60 * 1000;

/**
 * Adds up the usage in every project's session files, active and archived.
 * Files are read once and then only from where they grew, so opening the
 * page again costs a stat per conversation.
 */
export class UsageIndex {
  readonly #files = new Map<string, FileUsage>();
  #running?: Promise<UsageStats>;

  constructor(private readonly projects: () => readonly ProjectState[]) {}

  stats(): Promise<UsageStats> {
    this.#running ??= this.#collect().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #collect(): Promise<UsageStats> {
    const projects = this.projects();
    const live = new Set<string>();
    // A branch copies its source's entries; keep one of each, and the
    // longest of a turn that went on in one of the copies.
    const records = new Map<
      string,
      { projectId: string; record: UsageRecord }
    >();
    for (const project of projects) {
      const directory = sessionDirectory(project);
      const [active, archived] = await Promise.all([
        sessionFiles(directory),
        sessionFiles(path.join(directory, "archived")),
      ]);
      const files = [...active, ...archived];
      for (const file of files) live.add(file);
      for await (const usage of this.#readFiles(files)) {
        if (!usage) continue;
        const open = usage.turn && closedTurn(usage.turn);
        for (const record of open ? [...usage.records, open] : usage.records) {
          const known = records.get(record.key)?.record;
          if (
            !known ||
            (known.kind === "turn" &&
              record.kind === "turn" &&
              record.durationMs > known.durationMs)
          )
            records.set(record.key, { projectId: project.id, record });
        }
      }
    }
    for (const file of this.#files.keys())
      if (!live.has(file)) this.#files.delete(file);

    const rows = new Map<string, UsageRow>();
    for (const { projectId, record } of records.values()) {
      const key = `${record.date}\0${projectId}\0${record.provider}\0${record.model}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          date: record.date,
          projectId,
          provider: record.provider,
          model: record.model,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          turns: 0,
          durationMs: 0,
        };
        rows.set(key, row);
      }
      if (record.kind === "tokens") {
        row.input += record.input;
        row.output += record.output;
        row.cacheRead += record.cacheRead;
        row.cacheWrite += record.cacheWrite;
      } else {
        row.turns += 1;
        row.durationMs += record.durationMs;
      }
    }
    return {
      rows: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)),
      projects: projects.map(({ id, name }) => ({ id, name })),
    };
  }

  async *#readFiles(files: string[]) {
    // Bound the number of open files and chunk buffers. Consume results in directory order.
    for (let start = 0; start < files.length; start += FILES_PER_BATCH) {
      const batch = files.slice(start, start + FILES_PER_BATCH);
      const results = await Promise.allSettled(batch.map((file) => this.#read(file)));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        yield result.value;
      }
    }
  }

  async #read(file: string): Promise<FileUsage | undefined> {
    const stats = await stat(file).catch(() => undefined);
    if (!stats) {
      this.#files.delete(file);
      return undefined;
    }
    const cached = this.#files.get(file);
    if (
      cached &&
      cached.inode === stats.ino &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs
    )
      return cached;
    const handle = await open(file, "r").catch(() => undefined);
    if (!handle) return cached;
    try {
      let usage: FileUsage = {
        inode: stats.ino,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        offset: 0,
        tail: Buffer.alloc(0),
        records: [],
      };
      // Sessions only grow; one that grew keeps every byte read so far, which
      // its last few confirm. Anything else, even at the same size, is read
      // again from the start.
      if (
        cached &&
        cached.inode === stats.ino &&
        stats.size > cached.size &&
        cached.offset > 0
      ) {
        const tail = Buffer.alloc(cached.tail.length);
        await handle.read(tail, 0, tail.length, cached.offset - tail.length);
        if (tail.equals(cached.tail))
          usage = {
            ...usage,
            offset: cached.offset,
            tail: cached.tail,
            records: [...cached.records],
            ...(cached.turn ? { turn: { ...cached.turn } } : {}),
          };
      }
      // Read in chunks so a long conversation neither fills memory nor holds
      // up the service. A line keeps its first bytes, and the rest only when
      // those show it may hold usage; a line cut off at the end of the file
      // is still being written and waits for the next look.
      const chunk = Buffer.allocUnsafe(
        Math.min(CHUNK_BYTES, Math.max(1, stats.size - usage.offset)),
      );
      let partial: LineReader | undefined;
      let position = usage.offset;
      let consumed = usage.offset;
      while (position < stats.size) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, stats.size - position),
          position,
        );
        if (bytesRead <= 0) break;
        const bytes = chunk.subarray(0, bytesRead);
        for (let start = 0; start < bytesRead;) {
          const newline = bytes.indexOf(0x0a, start);
          if (newline < 0) {
            (partial ??= new LineReader()).take(bytes.subarray(start));
            break;
          }
          if (partial) {
            partial.take(bytes.subarray(start, newline));
            const { head, whole } = partial.finish();
            readLine(usage, head, whole);
            partial = undefined;
          } else {
            const headEnd = Math.min(start + HEAD_BYTES, newline);
            const head = bytes.toString("utf8", start, headEnd);
            const whole = mayHoldUsage(head)
              ? headEnd === newline ? head : bytes.toString("utf8", start, newline)
              : undefined;
            readLine(usage, head, whole);
          }
          consumed = position + newline + 1;
          start = newline + 1;
        }
        position += bytesRead;
        await setImmediate();
      }
      if (consumed > usage.offset) {
        usage.offset = consumed;
        const tail = Buffer.alloc(Math.min(TAIL_BYTES, consumed));
        await handle.read(tail, 0, tail.length, consumed - tail.length);
        usage.tail = tail;
      }
      this.#files.set(file, usage);
      return usage;
    } finally {
      await handle.close();
    }
  }
}

/** One line read across chunks: its first bytes, and the rest only if they ask for it. */
class LineReader {
  readonly #head: Buffer[] = [];
  #headLength = 0;
  #keep?: boolean;
  readonly #rest: Buffer[] = [];

  take(bytes: Buffer): void {
    if (this.#keep === undefined) {
      const head = bytes.subarray(0, HEAD_BYTES - this.#headLength);
      this.#head.push(Buffer.from(head));
      this.#headLength += head.length;
      bytes = bytes.subarray(head.length);
      if (this.#headLength < HEAD_BYTES) return;
      this.#keep = mayHoldUsage(Buffer.concat(this.#head).toString("utf8"));
    }
    if (this.#keep && bytes.length) this.#rest.push(Buffer.from(bytes));
  }

  finish(): { head: string; whole?: string } {
    const head = Buffer.concat(this.#head);
    const text = head.toString("utf8");
    const keep = this.#keep ?? mayHoldUsage(text);
    return keep
      ? {
          head: text,
          whole: Buffer.concat([head, ...this.#rest]).toString("utf8"),
        }
      : { head: text };
  }
}

/** Pi writes an entry's type, role and custom type first, so a line's head tells. */
function mayHoldUsage(head: string): boolean {
  return (
    head.includes(`"customType":"${NATIVE_USAGE_ENTRY}"`) ||
    (head.startsWith('{"type":"message"') &&
      head.includes('"message":{"role":"assistant"'))
  );
}

export function registerUsageRoutes(
  app: FastifyInstance,
  index: UsageIndex,
  /** Names to show for provider IDs, such as a custom provider's. */
  providers: () => Promise<Array<{ id: string; name: string }>>,
): void {
  app.get("/usage", async (): Promise<UsageStats> => {
    const [stats, named] = await Promise.all([
      index.stats(),
      providers().catch(() => []),
    ]);
    return {
      ...stats,
      providers: named.map(({ id, name }) => ({ id, name })),
    };
  });
}

async function sessionFiles(directory: string): Promise<string[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  return names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(directory, name));
}

/**
 * Follows one session line: a person's message starts a turn, the agent's
 * messages and usage extend it, and usage adds tokens. Other entries, such
 * as a rename or a changed setting, leave the turn's time alone. `whole` is
 * the decoded line when its head shows it may hold usage.
 */
function readLine(usage: FileUsage, head: string, whole?: string): void {
  if (head.startsWith('{"type":"session"')) return;
  const record = whole ? usageRecord(whole) : undefined;
  const timestamp = /"timestamp":"([^"]+)"/.exec(head)?.[1];
  // A long entry can push its own time past the head; its record has one.
  const time = timestamp ? Date.parse(timestamp) : (record?.time ?? Number.NaN);
  if (!Number.isFinite(time)) return;
  const message = head.startsWith('{"type":"message"');
  if (message && head.includes('"message":{"role":"user"')) {
    const finished = usage.turn && closedTurn(usage.turn);
    if (finished) usage.records.push(finished);
    const id = /"id":"([^"]+)"/.exec(head)?.[1] ?? "";
    usage.turn = {
      key: `turn|${id}|${timestamp ?? time}`,
      date: localDate(time),
      last: time,
      durationMs: 0,
    };
    return;
  }
  const turn = usage.turn;
  if (turn && (message || record) && time > turn.last) {
    turn.durationMs += Math.min(time - turn.last, IDLE_GAP_MS);
    turn.last = time;
  }
  if (!record) return;
  if (turn) {
    turn.provider = record.provider;
    turn.model = record.model;
  }
  if (record.kind === "tokens") {
    const { time: _time, ...tokens } = record;
    usage.records.push(tokens);
  }
}

function closedTurn(turn: OpenTurn): TurnRecord | undefined {
  if (!turn.provider || !turn.model || turn.durationMs <= 0) return undefined;
  return {
    kind: "turn",
    key: turn.key,
    date: turn.date,
    provider: turn.provider,
    model: turn.model,
    durationMs: turn.durationMs,
  };
}

/**
 * The tokens on a line: an assistant message from OhMyGame's agent, or a
 * coding agent's usage entry. A coding agent's own assistant messages carry
 * no tokens to count but still name the model its turn used.
 */
export function usageRecord(line: string):
  | ((TokenRecord | { kind: "model"; provider: string; model: string }) & {
      time: number;
    })
  | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = entry as {
    type?: unknown;
    customType?: unknown;
    data?: Partial<StoredNativeUsage>;
    timestamp?: unknown;
    message?: Record<string, unknown>;
  };
  if (record.type === "custom" && record.customType === NATIVE_USAGE_ENTRY) {
    const data = record.data ?? {};
    const tokens = counts(data);
    const at = typeof data.at === "number" ? data.at : Number.NaN;
    if (!tokens || !Number.isFinite(at)) return undefined;
    const provider =
      typeof data.runtime === "string" ? data.runtime : "unknown";
    const model = typeof data.model === "string" ? data.model : "unknown";
    return {
      kind: "tokens",
      key: `native|${provider}|${model}|${at}|${tokens.input}|${tokens.output}|${tokens.cacheRead}`,
      date: localDate(at),
      provider,
      model,
      ...tokens,
      time: at,
    };
  }
  const message = record.message;
  if (record.type !== "message" || message?.role !== "assistant")
    return undefined;
  const provider =
    typeof message.provider === "string" ? message.provider : "unknown";
  const model = typeof message.model === "string" ? message.model : "unknown";
  const time =
    typeof message.timestamp === "number"
      ? message.timestamp
      : typeof record.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
  if (!Number.isFinite(time)) return undefined;
  if (message.api === NATIVE_API)
    return { kind: "model", provider, model, time };
  const tokens = counts((message.usage ?? {}) as Record<string, unknown>);
  if (!tokens) return undefined;
  const responseId =
    typeof message.responseId === "string" ? message.responseId : "";
  return {
    kind: "tokens",
    key: `${responseId}|${provider}|${model}|${time}|${tokens.input}|${tokens.output}|${tokens.cacheRead}`,
    date: localDate(time),
    provider,
    model,
    ...tokens,
    time,
  };
}

function counts(
  usage: Record<string, unknown>,
):
  | { input: number; output: number; cacheRead: number; cacheWrite: number }
  | undefined {
  const tokens = {
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
  };
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0
    ? tokens
    : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}
