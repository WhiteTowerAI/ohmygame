import { expect, it, vi } from "vitest";
import { AsyncTaskPool } from "../src/desktop/async-task-pool.js";

it("limits active work and releases slots after failures", async () => {
  const pool = new AsyncTaskPool(2);
  let fail!: (error: Error) => void, finish!: () => void;
  const first = pool.run(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  const rejected = expect(first).rejects.toThrow("Capture failed");
  const second = pool.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const next = vi.fn(async () => true);
  const third = pool.run(next);
  expect(next).not.toHaveBeenCalled();
  fail(new Error("Capture failed"));
  await rejected;
  await expect(third).resolves.toBe(true);
  expect(next).toHaveBeenCalledOnce();
  finish(); await second;
});

it("removes cancelled queued work without delaying the next batch", async () => {
  const pool = new AsyncTaskPool(1), controller = new AbortController();
  let finish!: () => void;
  const first = pool.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const cancelledTask = vi.fn(async () => {});
  const queued = pool.run(cancelledTask, controller.signal);
  const rejected = expect(queued).rejects.toThrow();
  controller.abort(); await rejected;
  const next = pool.run(async () => "next");
  finish(); await first;
  await expect(next).resolves.toBe("next");
  expect(cancelledTask).not.toHaveBeenCalled();
});

it("honors cancellation after reserving a slot and releases that slot", async () => {
  const pool = new AsyncTaskPool(1), controller = new AbortController();
  let finish!: () => void;
  const first = pool.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const cancelledTask = vi.fn(async () => {});
  const queued = pool.run(cancelledTask, controller.signal);
  const rejected = expect(queued).rejects.toThrow();
  finish(); queueMicrotask(() => controller.abort());
  await Promise.all([first, rejected]);
  expect(cancelledTask).not.toHaveBeenCalled();
  await expect(pool.run(async () => "next")).resolves.toBe("next");
});
