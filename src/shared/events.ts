import { EventEmitter } from "node:events";
import type { RuntimeEvent, RuntimeEventData, RuntimeEventType } from "./contracts.js";

export class RuntimeEventBus {
  readonly #emitter = new EventEmitter();
  readonly #events: RuntimeEvent[] = [];
  #nextId = 1;

  constructor(private readonly capacity = 1_000) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Event capacity must be a positive integer");
    }
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
    if (this.#events.length > this.capacity) {
      this.#events.splice(0, this.#events.length - this.capacity);
    }
    this.#emitter.emit(projectId, event);
    return event;
  }

  since(projectId: string, cursor = 0): RuntimeEvent[] {
    return this.#events.filter((event) => event.projectId === projectId && event.id > cursor);
  }

  subscribe(projectId: string, listener: (event: RuntimeEvent) => void): () => void {
    this.#emitter.on(projectId, listener);
    return () => this.#emitter.off(projectId, listener);
  }
}
