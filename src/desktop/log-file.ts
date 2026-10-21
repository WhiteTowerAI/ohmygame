import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { MAX_LOG_LINE_LENGTH } from "./log-redaction.js";

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

  constructor(private readonly emit: (line: string) => void) {}

  write(chunk: string | Uint8Array): void {
    this.#pending +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let end = this.#pending.indexOf("\n");
    while (end !== -1) {
      const line = this.#pending.slice(0, end);
      this.emit(line.endsWith("\r") ? line.slice(0, -1) : line);
      this.#pending = this.#pending.slice(end + 1);
      end = this.#pending.indexOf("\n");
    }
    if (this.#pending.length > MAX_LOG_LINE_LENGTH) this.flush();
  }

  flush(): void {
    if (this.#pending) this.emit(this.#pending);
    this.#pending = "";
  }
}

/**
 * An append-only log, each line redacted and timestamped. Only the newest
 * files are kept. A log that cannot be written stops quietly: logging never
 * fails the app.
 */
export class RotatingLogFile implements LogWriter, LogStream {
  readonly path: string;
  #output = new LineBuffer((line) => this.line(line));
  #descriptor?: number;
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

  line(text: string): void {
    if (this.#failed) return;
    const redacted = this.options.redact ? this.options.redact(text) : text;
    const time = (this.options.now?.() ?? new Date()).toISOString();
    this.#append(Buffer.from(`${time} ${redacted}\n`, "utf8"));
  }

  close(): void {
    this.flush();
    this.#closeDescriptor();
  }

  #append(bytes: Buffer): void {
    try {
      if (this.#descriptor === undefined) this.#open();
      const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
      if (this.#size > 0 && this.#size + bytes.length > maxBytes) {
        this.#rotate();
      }
      writeSync(this.#descriptor!, bytes);
      this.#size += bytes.length;
    } catch {
      this.#failed = true;
      this.#closeDescriptor();
    }
  }

  #open(): void {
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
    this.#descriptor = openSync(this.path, "a", 0o600);
    this.#size = fstatSync(this.#descriptor).size;
  }

  #rotate(): void {
    // Windows cannot rename an open file.
    this.#closeDescriptor();
    const maxFiles = Math.max(1, this.options.maxFiles ?? DEFAULT_MAX_FILES);
    rmSync(this.#file(maxFiles - 1), { force: true });
    for (let index = maxFiles - 2; index >= 0; index--) {
      try {
        renameSync(this.#file(index), this.#file(index + 1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.#open();
  }

  #closeDescriptor(): void {
    if (this.#descriptor === undefined) return;
    try {
      closeSync(this.#descriptor);
    } catch {
      // The descriptor is gone either way.
    }
    this.#descriptor = undefined;
  }

  #file(index: number): string {
    const suffix = index === 0 ? "" : `.${index}`;
    return path.join(
      this.options.directory,
      `${this.options.name}${suffix}.log`,
    );
  }
}
