import { EventEmitter } from "node:events";
import type { RuntimeEvent, RuntimeEventData, RuntimeEventType } from "./contracts.js";

export class RuntimeEventBus {
  readonly #emitter = new EventEmitter();
  readonly #events: RuntimeEvent[] = [];
  readonly #droppedThrough = new Map<string, number>();
  #nextId = 1;

  constructor(private readonly capacity = 1_000) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Event capacity must be a positive integer");
    }
  }

  publish<T extends RuntimeEventType>(
    projectId: string,
    type: T,
    data: RuntimeEventData[T],
    scope: { conversationId: string; turnId?: string } | undefined = undefined,
    replayData?: RuntimeEventData[T],
  ): RuntimeEvent<T> {
    const event = {
      id: this.#nextId++,
      projectId,
      ...scope,
      type,
      timestamp: new Date().toISOString(),
      data,
    } as RuntimeEvent<T>;
    this.#events.push(replayData === undefined ? event : { ...event, data: replayData } as RuntimeEvent<T>);
    if (this.#events.length > this.capacity) {
      const dropped = this.#events.splice(0, this.#events.length - this.capacity);
      for (const oldEvent of dropped) this.#markDropped(oldEvent.projectId, oldEvent.id);
    }
    this.#emitter.emit(projectId, event);
    return event;
  }

  since(projectId: string, cursor = 0): RuntimeEvent[] {
    return this.#events.filter((event) => event.projectId === projectId && event.id > cursor);
  }

  cursor(): number {
    return this.#nextId - 1;
  }

  canReplay(projectId: string, cursor: number): boolean {
    return cursor >= (this.#droppedThrough.get(projectId) ?? 0);
  }

  expireThrough(projectId: string, eventId: number): void {
    this.#markDropped(projectId, eventId);
  }

  subscribe(projectId: string, listener: (event: RuntimeEvent) => void): () => void {
    this.#emitter.on(projectId, listener);
    return () => this.#emitter.off(projectId, listener);
  }

  #markDropped(projectId: string, eventId: number): void {
    this.#droppedThrough.set(projectId, Math.max(eventId, this.#droppedThrough.get(projectId) ?? 0));
  }
}
