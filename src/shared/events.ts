import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_EVENT_TYPES, type RuntimeEvent, type RuntimeEventData, type RuntimeEventType } from "./contracts.js";

export class RuntimeEventBus {
  readonly #emitter = new EventEmitter();
  readonly #events: RuntimeEvent[] = [];
  readonly #pendingWrites = new Map<string, string[]>();
  readonly #writeTimers = new Map<string, NodeJS.Timeout>();
  readonly #writes = new Map<string, Promise<void>>();
  readonly #persistedCounts = new Map<string, number>();
  #writeError: unknown;
  #nextId = 1;

  constructor(
    private readonly capacity = 1_000,
    private readonly projectsDirectory?: string,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Event capacity must be a positive integer");
  }

  async load(projectIds: readonly string[]): Promise<void> {
    if (!this.projectsDirectory) return;
    const loaded: RuntimeEvent[] = [];
    for (const projectId of projectIds) {
      const eventFile = this.#eventFile(projectId);
      try {
        const content = await readFile(eventFile, "utf8");
        const valid: RuntimeEvent[] = [];
        let needsRepair = false;
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          const event = parseRuntimeEvent(line, projectId);
          if (event) valid.push(event);
          else needsRepair = true;
        }
        loaded.push(...valid);
        this.#persistedCounts.set(projectId, valid.length);
        if (needsRepair) await rewriteEvents(eventFile, valid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    loaded.sort((left, right) => left.id - right.id);
    this.#events.push(...loaded.slice(-this.capacity));
    this.#nextId = Math.max(0, ...loaded.map((event) => event.id)) + 1;
  }

  publish<T extends RuntimeEventType>(projectId: string, type: T, data: RuntimeEventData[T]): RuntimeEvent<T> {
    const event = {
      id: this.#nextId++,
      projectId,
      type,
      timestamp: new Date().toISOString(),
      data,
    } as RuntimeEvent<T>;
    this.#events.push(event);
    if (this.#events.length > this.capacity) this.#events.splice(0, this.#events.length - this.capacity);
    if (this.projectsDirectory) {
      const pending = this.#pendingWrites.get(projectId) ?? [];
      pending.push(`${JSON.stringify(event)}\n`);
      this.#pendingWrites.set(projectId, pending);
      if (!this.#writeTimers.has(projectId)) {
        this.#writeTimers.set(projectId, setTimeout(() => this.#queueWrite(projectId), 25));
      }
    }
    this.#emitter.emit(projectId, event);
    return event;
  }

  since(projectId: string, cursor = 0): RuntimeEvent[] {
    const inMemory = this.#events.filter((event) => event.projectId === projectId);
    if (!this.projectsDirectory || (inMemory.length > 0 && cursor >= inMemory[0].id - 1)) {
      return inMemory.filter((event) => event.id > cursor);
    }
    try {
      const persisted = readFileSync(this.#eventFile(projectId), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => parseRuntimeEvent(line, projectId))
        .filter((event): event is RuntimeEvent => Boolean(event && event.id > cursor));
      const combined = new Map(persisted.map((event) => [event.id, event]));
      for (const event of inMemory) {
        if (event.id > cursor) combined.set(event.id, event);
      }
      return [...combined.values()].sort((left, right) => left.id - right.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return inMemory.filter((event) => event.id > cursor);
      }
      throw error;
    }
  }

  subscribe(projectId: string, listener: (event: RuntimeEvent) => void): () => void {
    this.#emitter.on(projectId, listener);
    return () => this.#emitter.off(projectId, listener);
  }

  async prepareProject(projectId: string): Promise<void> {
    if (this.projectsDirectory) await mkdir(path.dirname(this.#eventFile(projectId)), { recursive: true });
  }

  async flush(): Promise<void> {
    for (const projectId of this.#pendingWrites.keys()) this.#queueWrite(projectId);
    await Promise.all(this.#writes.values());
    if (this.#writeError) throw this.#writeError;
  }

  #queueWrite(projectId: string): void {
    const timer = this.#writeTimers.get(projectId);
    if (timer) clearTimeout(timer);
    this.#writeTimers.delete(projectId);
    const lines = this.#pendingWrites.get(projectId);
    if (!lines?.length) return;
    this.#pendingWrites.delete(projectId);

    const write = (this.#writes.get(projectId) ?? Promise.resolve()).then(async () => {
      const nextCount = (this.#persistedCounts.get(projectId) ?? 0) + lines.length;
      if (nextCount > this.capacity * 2) {
        const existing = await readFile(this.#eventFile(projectId), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        const retained = [...existing.split("\n").filter(Boolean), ...lines]
          .map((line) => parseRuntimeEvent(line, projectId))
          .filter((event): event is RuntimeEvent => Boolean(event))
          .slice(-this.capacity);
        await rewriteEvents(this.#eventFile(projectId), retained);
        this.#persistedCounts.set(projectId, retained.length);
      } else {
        await appendFile(this.#eventFile(projectId), lines.join(""), "utf8");
        this.#persistedCounts.set(projectId, nextCount);
      }
    });
    const tracked = write.catch((error) => { this.#writeError ??= error; });
    this.#writes.set(projectId, tracked);
  }

  #eventFile(projectId: string): string {
    return path.join(this.projectsDirectory!, projectId, "events.jsonl");
  }
}

async function rewriteEvents(eventFile: string, events: RuntimeEvent[]): Promise<void> {
  const temporary = `${eventFile}.${process.pid}.tmp`;
  const content = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(temporary, content ? `${content}\n` : "", "utf8");
  await rename(temporary, eventFile);
}

function parseRuntimeEvent(line: string, projectId: string): RuntimeEvent | undefined {
  try {
    const event = JSON.parse(line) as Partial<RuntimeEvent>;
    if (
      Number.isInteger(event.id) && Number(event.id) > 0 &&
      event.projectId === projectId &&
      typeof event.type === "string" && RUNTIME_EVENT_TYPES.includes(event.type as RuntimeEventType) &&
      typeof event.timestamp === "string" && event.data && typeof event.data === "object"
    ) return event as RuntimeEvent;
  } catch {}
  return undefined;
}
