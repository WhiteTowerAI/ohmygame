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
    scope: { conversationId: string; turnId: string } | undefined = undefined,
  ): RuntimeEvent<T> {
    const event = {
      id: this.#nextId++,
      projectId,
      ...scope,
      type,
      timestamp: new Date().toISOString(),
      data,
    } as RuntimeEvent<T>;
    this.#events.push(event);
    if (this.#events.length > this.capacity) {
      const dropped = this.#events.splice(0, this.#events.length - this.capacity);
      for (const oldEvent of dropped) this.#droppedThrough.set(oldEvent.projectId, oldEvent.id);
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

  subscribe(projectId: string, listener: (event: RuntimeEvent) => void): () => void {
    this.#emitter.on(projectId, listener);
    return () => this.#emitter.off(projectId, listener);
  }
}
