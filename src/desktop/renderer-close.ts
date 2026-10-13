/** Wait for the main renderer to finish saving while its daemon is still alive. */
export class RendererCloseRequest {
  #nextId = 0;
  #pending?: {
    id: number;
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(
    private readonly send: (id: number) => void,
    private readonly cancel: (id: number, error: string) => void,
    private readonly timeoutMs = 30_000,
  ) {}

  request(): Promise<void> {
    if (this.#pending) return this.#pending.promise;
    const id = ++this.#nextId;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => this.complete(id, "Saving took too long. The workspace is still open; try closing again once saving finishes."), this.timeoutMs);
    this.#pending = { id, promise, resolve, reject, timer };
    try { this.send(id); }
    catch (cause) { this.complete(id, cause instanceof Error ? cause.message : String(cause)); }
    return promise;
  }

  complete(id: number, error?: string): void {
    const pending = this.#pending;
    if (!pending || pending.id !== id) return;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    if (error) {
      this.cancel(id, error);
      pending.reject(new Error(error));
    } else pending.resolve();
  }
}
