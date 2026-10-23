import { appendFileSync, mkdirSync } from "node:fs";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  MAX_LOG_INPUT_LENGTH,
  OMITTED_LOG_TEXT,
} from "../shared/log-redaction.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

/** Output that arrives in chunks and is logged line by line. */
export interface LogStream {
  write(chunk: string | Uint8Array): void;
  /** Logs a partial last line. */
  flush(): void;
}

export interface LogWriter {
  line(text: string): void;
  /** A separate line buffer, for output that arrives interleaved with other output. */
  stream(): LogStream;
}

export interface RotatingLogFileOptions {
  directory: string;
  /** `daemon` writes `daemon.log`, then moves older output to `daemon.1.log`, `daemon.2.log`. */
  name: string;
  maxBytes?: number;
  /** The current file included. */
  maxFiles?: number;
  redact?: (line: string) => string;
  now?: () => Date;
}

class LineBuffer implements LogStream {
  #pending = "";
  #discarding = false;
  // A character can be split between two chunks of a process's output.
  readonly #decoder = new StringDecoder("utf8");

  constructor(private readonly emit: (line: string) => void) {}

  write(chunk: string | Uint8Array): void {
    let text =
      typeof chunk === "string"
        ? chunk
        : this.#decoder.write(Buffer.from(chunk));
    if (this.#discarding) {
      const end = text.indexOf("\n");
      if (end === -1) return;
      this.#discarding = false;
      text = text.slice(end + 1);
    }
    this.#pending += text;
    let end = this.#pending.indexOf("\n");
    while (end !== -1) {
      const line = this.#pending.slice(0, end);
      this.emit(
        line.length > MAX_LOG_INPUT_LENGTH
          ? OMITTED_LOG_TEXT
          : line.endsWith("\r")
            ? line.slice(0, -1)
            : line,
      );
      this.#pending = this.#pending.slice(end + 1);
      end = this.#pending.indexOf("\n");
    }
    if (this.#pending.length > MAX_LOG_INPUT_LENGTH) {
      // Keep discarding until the logical line ends. Logging a partial JSON
      // record can separate a credential from the field that identifies it.
      this.#pending = "";
      this.#discarding = true;
      this.emit(OMITTED_LOG_TEXT);
    }
  }

  flush(): void {
    this.#pending += this.#decoder.end();
    if (this.#pending && !this.#discarding) this.emit(this.#pending);
    this.#pending = "";
    this.#discarding = false;
  }
}

/**
 * An append-only log, each line redacted and timestamped. Lines are written
 * in the background, so logging never blocks the Electron main thread, and
 * only the newest files are kept. A log that cannot be written stops
 * quietly: logging never fails the app.
 */
export class RotatingLogFile implements LogWriter, LogStream {
  readonly path: string;
  #output = new LineBuffer((line) => this.line(line));
  #pending: Buffer[] = [];
  #draining?: Promise<void>;
  #handle?: FileHandle;
  #size = 0;
  #failed = false;

  constructor(private readonly options: RotatingLogFileOptions) {
    this.path = this.#file(0);
  }

  write(chunk: string | Uint8Array): void {
    this.#output.write(chunk);
  }

  flush(): void {
    this.#output.flush();
  }

  stream(): LogStream {
    return new LineBuffer((line) => this.line(line));
  }

  /** Text with line breaks, such as an error with its output, is written one timestamped line at a time. */
  line(text: string): void {
    if (this.#failed) return;
    const time = (this.options.now?.() ?? new Date()).toISOString();
    const redacted = this.options.redact ? this.options.redact(text) : text;
    const lines = redacted.split(/\r?\n/).map((line) => `${time} ${line}\n`);
    this.#pending.push(Buffer.from(lines.join(""), "utf8"));
    // Start on a later tick, so flushSync can still take lines logged just before it.
    this.#draining ??= Promise.resolve().then(() => this.#drain());
  }

  /** Resolves once every line logged so far is written. */
  async idle(): Promise<void> {
    while (this.#draining) await this.#draining;
  }

  /**
   * Writes the lines still waiting, synchronously, for a process that is
   * about to end and cannot wait for the background writes.
   */
  flushSync(): void {
    this.flush();
    if (this.#failed || !this.#pending.length) return;
    try {
      mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
      appendFileSync(this.path, Buffer.concat(this.#pending.splice(0)), {
        mode: 0o600,
      });
    } catch {
      // Nothing more can be done for a process that is ending.
    }
  }

  async close(): Promise<void> {
    this.flush();
    await this.idle();
    await this.#closeHandle();
  }

  async #drain(): Promise<void> {
    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    try {
      while (this.#pending.length) {
        const entries = this.#pending.splice(0);
        let batch: Buffer[] = [];
        let batchSize = 0;
        for (const entry of entries) {
          if (!this.#handle) await this.#open();
          const written = this.#size + batchSize;
          if (written > 0 && written + entry.length > maxBytes) {
            await this.#writeOut(batch);
            batch = [];
            batchSize = 0;
            await this.#rotate();
          }
          batch.push(entry);
          batchSize += entry.length;
        }
        await this.#writeOut(batch);
      }
    } catch {
      this.#failed = true;
      this.#pending = [];
      await this.#closeHandle();
    } finally {
      this.#draining = undefined;
    }
  }

  async #writeOut(batch: Buffer[]): Promise<void> {
    if (!batch.length) return;
    const bytes = Buffer.concat(batch);
    await this.#handle!.write(bytes);
    this.#size += bytes.length;
  }

  async #open(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    this.#handle = await open(this.path, "a", 0o600);
    this.#size = (await this.#handle.stat()).size;
  }

  async #rotate(): Promise<void> {
    // Windows cannot rename an open file.
    await this.#closeHandle();
    const maxFiles = Math.max(1, this.options.maxFiles ?? DEFAULT_MAX_FILES);
    await rm(this.#file(maxFiles - 1), { force: true });
    for (let index = maxFiles - 2; index >= 0; index--) {
      try {
        await rename(this.#file(index), this.#file(index + 1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await this.#open();
  }

  async #closeHandle(): Promise<void> {
    const handle = this.#handle;
    this.#handle = undefined;
    await handle?.close().catch(() => {
      // The handle is gone either way.
    });
  }

  #file(index: number): string {
    const suffix = index === 0 ? "" : `.${index}`;
    return path.join(
      this.options.directory,
      `${this.options.name}${suffix}.log`,
    );
  }
}
