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
      const files = [
        ...(await sessionFiles(directory)),
        ...(await sessionFiles(path.join(directory, "archived"))),
      ];
      for (const file of files) {
        live.add(file);
        const usage = await this.#read(file);
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
      // An append keeps every byte read so far; check the last few of them.
      if (
        cached &&
        cached.inode === stats.ino &&
        stats.size >= cached.offset &&
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
      // Read in chunks, so a long conversation neither fills memory nor holds
      // up the service; a line cut at a chunk's end waits for the next one.
      let pending = Buffer.alloc(0);
      let position = usage.offset;
      // One buffer for the file; what outlives a chunk is copied out of it.
      const chunk = Buffer.allocUnsafe(
        Math.min(CHUNK_BYTES, Math.max(1, stats.size - position)),
      );
      while (position < stats.size) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, stats.size - position),
          position,
        );
        if (bytesRead <= 0) break;
        position += bytesRead;
        const bytes = pending.length
          ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        const end = bytes.lastIndexOf(0x0a) + 1;
        if (end > 0) {
          for (let start = 0; start < end;) {
            const stop = bytes.indexOf(0x0a, start);
            readLine(usage, bytes, start, stop);
            start = stop + 1;
          }
          usage.offset += end;
          usage.tail = Buffer.from(
            bytes.subarray(Math.max(0, end - TAIL_BYTES), end),
          );
        }
        pending = Buffer.from(bytes.subarray(end));
        await setImmediate();
      }
      this.#files.set(file, usage);
      return usage;
    } finally {
      await handle.close();
    }
  }
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
 * Follows one session line: a person's message starts a turn, anything
 * after it extends the turn, and usage adds tokens. Lines are read from
 * their first bytes, where Pi writes an entry's type, role and time; only
 * those that may hold usage are decoded whole, since tool output and pasted
 * files make most of a session's size.
 */
function readLine(
  usage: FileUsage,
  bytes: Buffer,
  start: number,
  end: number,
): void {
  const head = bytes.toString("utf8", start, Math.min(end, start + HEAD_BYTES));
  const timestamp = /"timestamp":"([^"]+)"/.exec(head)?.[1];
  const time = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(time) || head.startsWith('{"type":"session"')) return;
  if (
    head.startsWith('{"type":"message"') &&
    head.includes('"message":{"role":"user"')
  ) {
    const finished = usage.turn && closedTurn(usage.turn);
    if (finished) usage.records.push(finished);
    const id = /"id":"([^"]+)"/.exec(head)?.[1] ?? "";
    usage.turn = {
      key: `turn|${id}|${timestamp}`,
      date: localDate(time),
      last: time,
      durationMs: 0,
    };
    return;
  }
  const turn = usage.turn;
  if (turn && time > turn.last) {
    turn.durationMs += Math.min(time - turn.last, IDLE_GAP_MS);
    turn.last = time;
  }
  const mayHoldUsage =
    head.includes(`"customType":"${NATIVE_USAGE_ENTRY}"`) ||
    (head.startsWith('{"type":"message"') &&
      head.includes('"message":{"role":"assistant"'));
  if (!mayHoldUsage) return;
  const record = usageRecord(bytes.toString("utf8", start, end));
  if (!record) return;
  if (turn) {
    turn.provider = record.provider;
    turn.model = record.model;
  }
  if (record.kind === "tokens") usage.records.push(record);
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
export function usageRecord(
  line: string,
):
  TokenRecord | { kind: "model"; provider: string; model: string } | undefined {
  const native = line.includes(`"${NATIVE_USAGE_ENTRY}"`);
  // Most lines are tool results and user messages; skip them unparsed.
  if (!native && (!line.includes('"usage"') || !line.includes('"assistant"')))
    return undefined;
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
    };
  }
  const message = record.message;
  if (record.type !== "message" || message?.role !== "assistant")
    return undefined;
  const provider =
    typeof message.provider === "string" ? message.provider : "unknown";
  const model = typeof message.model === "string" ? message.model : "unknown";
  if (message.api === NATIVE_API) return { kind: "model", provider, model };
  const tokens = counts((message.usage ?? {}) as Record<string, unknown>);
  const time =
    typeof message.timestamp === "number"
      ? message.timestamp
      : typeof record.timestamp === "string"
        ? Date.parse(record.timestamp)
        : Number.NaN;
  if (!tokens || !Number.isFinite(time)) return undefined;
  const responseId =
    typeof message.responseId === "string" ? message.responseId : "";
  return {
    kind: "tokens",
    key: `${responseId}|${provider}|${model}|${time}|${tokens.input}|${tokens.output}|${tokens.cacheRead}`,
    date: localDate(time),
    provider,
    model,
    ...tokens,
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
