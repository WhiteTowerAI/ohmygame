import { describe, expect, it } from "vitest";
import { forgetPendingPublish, rememberPendingPublish, takePendingPublish } from "../src/renderer/pending-publish.js";

describe("pending Web publish", () => {
  it("resumes the matching project once", () => {
    const storage = new MemoryStorage();
    rememberPendingPublish(storage, "project-1", 1_000);

    expect(takePendingPublish(storage, "project-1", 2_000)).toBe(true);
    expect(takePendingPublish(storage, "project-1", 2_000)).toBe(false);
  });

  it("does not resume another project or an expired request", () => {
    const storage = new MemoryStorage();
    rememberPendingPublish(storage, "project-1", 1_000);
    expect(takePendingPublish(storage, "project-2", 2_000)).toBe(false);

    rememberPendingPublish(storage, "project-1", 1_000);
    expect(takePendingPublish(storage, "project-1", 16 * 60 * 1_000)).toBe(false);
  });

  it("can discard a cancelled request", () => {
    const storage = new MemoryStorage();
    rememberPendingPublish(storage, "project-1");
    forgetPendingPublish(storage);
    expect(takePendingPublish(storage, "project-1")).toBe(false);
  });
});

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}
