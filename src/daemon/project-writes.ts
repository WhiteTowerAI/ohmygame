import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

export class ProjectWriteError extends Error {
  readonly statusCode = 409;
  constructor(
    message: string,
    readonly code: "workspace_busy" | "workspace_stale",
  ) {
    super(message);
  }
}

/** How long a request waits for a workspace operation before it is refused. */
const ENTER_WAIT_MS = 120_000;

/** HTTP requests already in flight drain before an exclusive workspace
 * operation. A snapshot only reads the workspace, so reads go on during one
 * and writes wait for it. A restore replaces the files: reads wait for its
 * result, and writes are refused rather than applied over the restored
 * content. */
export class ProjectWrites {
  #requests = new WeakMap<FastifyRequest, () => void>();
  #running = new WeakSet<FastifyRequest>();
  track(request: FastifyRequest, release: () => void): void {
    this.#requests.set(request, release);
  }
  release(request: FastifyRequest): void {
    this.#requests.get(request)?.();
    this.#requests.delete(request);
  }
  install(app: FastifyInstance): void {
    const writes = this;
    // A disconnected client does not cancel its handler. Drain the actual
    // operation before restoring, rather than releasing on socket abort.
    app.addHook("onRoute", (route) => {
      const handler = route.handler;
      route.handler = async function (request, reply) {
        writes.#running.add(request);
        try {
          return await handler.call(this, request, reply);
        } finally {
          writes.#running.delete(request);
          writes.release(request);
        }
      };
    });
    app.addHook("onResponse", async (request) => {
      if (!writes.#running.has(request)) writes.release(request);
    });
    app.addHook("onError", async (request) => {
      if (!writes.#running.has(request)) writes.release(request);
    });
  }
  #states = new Map<
    string,
    {
      version: string;
      active: number;
      lock?: { kind: "snapshot" | "mutation"; done: Promise<void> };
      drained?: () => void;
    }
  >();
  #state(id: string) {
    let state = this.#states.get(id);
    if (!state) {
      state = { version: "0", active: 0 };
      this.#states.set(id, state);
    }
    return state;
  }
  isMutating(id: string): boolean {
    return this.#state(id).lock?.kind === "mutation";
  }
  version(id: string): string {
    return this.#state(id).version;
  }
  initialize(id: string, version: string): void {
    this.#state(id).version = version;
  }
  changed(id: string): string {
    return (this.#state(id).version = randomUUID());
  }
  assertVersion(id: string, version?: string): void {
    const state = this.#state(id);
    if (
      (version !== undefined && version !== state.version) ||
      (version === undefined && state.version !== "0")
    ) {
      throw new ProjectWriteError(
        "The workspace was restored. Reload it before saving changes.",
        "workspace_stale",
      );
    }
  }
  /**
   * Admits a request to the workspace. `read` requests do not change it; a
   * write carries the workspace version its content was made from.
   */
  async enter(id: string, read: boolean, version?: string): Promise<() => void> {
    const state = this.#state(id);
    const deadline = Date.now() + ENTER_WAIT_MS;
    while (state.lock && !(read && state.lock.kind === "snapshot")) {
      const remaining = deadline - Date.now();
      if (state.lock.kind === "mutation" && !read || remaining <= 0)
        throw new ProjectWriteError(
          "The workspace is being checkpointed or restored. Try again when it finishes.",
          "workspace_busy",
        );
      let timer!: ReturnType<typeof setTimeout>;
      await Promise.race([
        state.lock.done,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
      ]);
      clearTimeout(timer);
    }
    // A read gets the workspace as it is now, so it has no version to match.
    if (!read) this.assertVersion(id, version);
    state.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--state.active === 0) state.drained?.();
    };
  }
  async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.#exclusive(id, operation, "mutation");
  }
  /** Snapshots can wait for another snapshot or restore without failing a new
   * turn. Editor writes still drain and are refused while a snapshot reads. */
  async snapshot<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const state = this.#state(id);
    while (state.lock) await state.lock.done;
    return this.#exclusive(id, operation, "snapshot");
  }
  async #exclusive<T>(
    id: string,
    operation: () => Promise<T>,
    kind: "snapshot" | "mutation",
  ): Promise<T> {
    const state = this.#state(id);
    if (state.lock)
      throw new ProjectWriteError(
        "Another workspace operation is running.",
        "workspace_busy",
      );
    let unlock!: () => void;
    const done = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    state.lock = { kind, done };
    try {
      if (state.active)
        await new Promise<void>((resolve) => {
          state.drained = resolve;
        });
      return await operation();
    } finally {
      state.drained = undefined;
      state.lock = undefined;
      unlock();
    }
  }
}
