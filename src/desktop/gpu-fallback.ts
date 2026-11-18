import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * What Chromium keeps doing when the machine's GPU process cannot stay alive:
 * it restarts the process a few times and then deliberately exits the app with
 * "GPU process isn't usable. Goodbye." The fallback counts the crashes and, past
 * a threshold, records that the next launch must run without the GPU.
 */
export const GPU_CRASH_LIMIT = 3;
/** Crashes further apart than this belong to different sessions of the GPU process. */
export const GPU_CRASH_WINDOW_MS = 60_000;

interface GpuFallbackFile {
  version: 1;
  disabled: boolean;
}

function read(file: string): GpuFallbackFile | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || value.version !== 1 || typeof value.disabled !== "boolean") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Whether the next launch runs with software rendering; read before `app.whenReady()`. */
export function readGpuFallback(file: string): boolean {
  return read(file)?.disabled === true;
}

function write(file: string, value: GpuFallbackFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (cause) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* Keep the write error. */
    }
    throw cause;
  }
}

/** Settings: turning the GPU back on clears the flag, so it applies on the next launch. */
export function setGpuFallback(file: string, disabled: boolean): void {
  if (disabled) write(file, { version: 1, disabled: true });
  else rmSync(file, { force: true });
}

/**
 * Whether one gone child process counts as a GPU crash. A GPU process that
 * ended normally, for instance when Chromium reconfigures it, is not a crash.
 */
export function isGpuCrash(details: { type: string; reason: string }): boolean {
  return details.type === "GPU" && details.reason !== "clean-exit";
}

/**
 * Counts GPU process crashes of one launch. The `gone` details arrive before
 * Chromium gives up on the GPU entirely, so the flag is in place for the
 * relaunch that the app performs when the threshold is reached.
 */
export class GpuCrashCounter {
  #crashes = 0;
  #lastCrash = 0;
  /** Fixed for this launch, even if Settings clears the flag before restarting. */
  readonly startedWithFallback: boolean;

  constructor(
    private readonly file: string,
    private readonly limit = GPU_CRASH_LIMIT,
    private readonly windowMs = GPU_CRASH_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.startedWithFallback = readGpuFallback(file);
  }

  /**
   * Records one gone GPU process and says whether the app should relaunch with
   * software rendering. Writes the fallback flag when the limit is reached.
   */
  recordGpuCrash(): boolean {
    // Relaunching cannot recover a launch that already uses software rendering.
    if (this.startedWithFallback) return false;
    const at = this.now();
    this.#crashes = at - this.#lastCrash > this.windowMs ? 1 : this.#crashes + 1;
    this.#lastCrash = at;
    if (this.#crashes < this.limit) return false;
    setGpuFallback(this.file, true);
    return true;
  }
}
