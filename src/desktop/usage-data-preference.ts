import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export class UsageDataPreference {
  #value: boolean | undefined;
  #readError: unknown;

  constructor(private readonly file: string) {
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as {
        version?: unknown;
        enabled?: unknown;
      } | null;
      if (stored?.version !== 1 || typeof stored.enabled !== "boolean")
        throw new Error("Unsupported usage data preference");
      this.#value = stored.enabled;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.#readError = error;
    }
  }

  get enabled(): boolean {
    return this.#value === true;
  }

  // compat: since beta.5.8, remove from beta.7 and 2026-12-12. Read the old renderer preference on first launch.
  initialize(legacyEnabled: boolean): void {
    if (this.#value === undefined && !this.#readError) this.set(legacyEnabled);
  }

  set(enabled: boolean): void {
    if (this.#readError) throw this.#readError;
    if (this.#value === enabled) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, enabled })}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Preserve the original write error. */
      }
      throw error;
    }
    this.#value = enabled;
  }
}
