import { describe, expect, it, vi } from "vitest";
import { DesktopSaveCoordinator } from "../src/renderer/desktop-save.js";

describe("saving before desktop close", () => {
  it("pauses background work before saving and waits for every workspace", async () => {
    const coordinator = new DesktopSaveCoordinator();
    let finish!: () => void;
    coordinator.register(async () => { expect(coordinator.getSnapshot().closing).toBe(true); throw new Error("Conflict"); });
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    coordinator.register(save);
    const pending = coordinator.prepare();
    const rejected = expect(pending).rejects.toThrow("Conflict");
    expect(coordinator.prepare()).toBe(pending);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledOnce();
    finish(); await rejected;
    coordinator.cancel("Conflict");
    expect(coordinator.getSnapshot()).toEqual({ closing: false, error: "Conflict" });
  });
  it("handles Home with no workspace and ignores disposed save handlers", async () => {
    const coordinator = new DesktopSaveCoordinator(), save = vi.fn(async () => {});
    coordinator.register(save)();
    await coordinator.prepare();
    expect(save).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().closing).toBe(true);
  });
  it("saves a newly opened workspace when a cancelled close is retried", async () => {
    const coordinator = new DesktopSaveCoordinator();
    let finish!: () => void;
    const remove = coordinator.register(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = coordinator.prepare();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    coordinator.cancel("Timeout"); remove();
    const nextSave = vi.fn(async () => {});
    coordinator.register(nextSave);
    const next = coordinator.prepare();
    expect(next).not.toBe(first);
    expect(nextSave).not.toHaveBeenCalled();
    finish(); await next;
    expect(nextSave).toHaveBeenCalledOnce();
  });
});
