import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

interface BackgroundTray {
  destroy(): void;
}

/** Main-process ownership: a Windows window may hide only after its tray exists. */
export class BackgroundRunning {
  #stored: Record<string, unknown> = { version: 1, enabled: false };
  #problem: unknown;
  #enabled = false;
  #tray?: BackgroundTray;
  #closed = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly createTray?: () => Promise<BackgroundTray>,
  ) {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (!value || value.version !== 1 || typeof value.enabled !== "boolean")
        throw new Error(
          "Unsupported background-running preference; the saved file was left unchanged",
        );
      this.#stored = value;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
        this.#problem = cause;
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  read(): boolean {
    if (this.#problem) throw this.#problem;
    return this.#enabled;
  }

  /** Restore before opening a window; failure leaves ordinary close behavior available. */
  initialize(): Promise<boolean> {
    return this.set(this.#stored.enabled === true);
  }

  set(enabled: boolean): Promise<boolean> {
    const run = this.#queue.then(async () => {
      if (this.#problem) throw this.#problem;
      if (this.#closed) throw new Error("The app is quitting");
      let created: BackgroundTray | undefined;
      try {
        if (enabled && !this.#tray) created = await this.createTray?.();
        if (this.#closed) throw new Error("The app is quitting");
        if (enabled !== this.#stored.enabled) {
          const next = { ...this.#stored, enabled };
          mkdirSync(path.dirname(this.file), { recursive: true });
          const temporary = `${this.file}.${randomUUID()}.tmp`;
          try {
            writeFileSync(temporary, `${JSON.stringify(next)}\n`, {
              mode: 0o600,
            });
            renameSync(temporary, this.file);
          } catch (cause) {
            try {
              rmSync(temporary, { force: true });
            } catch {
              /* Keep the write error. */
            }
            throw cause;
          }
          this.#stored = next;
        }
        this.#tray ??= created;
        this.#enabled = enabled;
        if (!enabled) {
          this.#tray?.destroy();
          this.#tray = undefined;
        }
        return enabled;
      } catch (cause) {
        created?.destroy();
        throw cause;
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  dispose(): void {
    this.#closed = true;
    this.#enabled = false;
    this.#tray?.destroy();
    this.#tray = undefined;
  }
}
