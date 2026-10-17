import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopUpdateCheckScheduler } from "../src/desktop/update-check-scheduler.js";
import type { DesktopUpdateCheckOutcome } from "../src/desktop/updater.js";

const FOCUS_INTERVAL_MS = 30 * 60_000;
const PERIODIC_INTERVAL_MS = 4 * 60 * 60_000;
const FIRST_RETRY_MS = 60_000;
const SECOND_RETRY_MS = 5 * 60_000;

class CheckRecorder {
  calls: Array<"automatic" | "manual"> = [];
  outcome: DesktopUpdateCheckOutcome = "checked";
  block: Promise<void> | undefined;
  error: Error | undefined;

  async check(automatic = false): Promise<DesktopUpdateCheckOutcome> {
    this.calls.push(automatic ? "automatic" : "manual");
    await this.block;
    if (this.error) throw this.error;
    return this.outcome;
  }
}

let recorder: CheckRecorder;
let scheduler: DesktopUpdateCheckScheduler;

beforeEach(() => {
  vi.useFakeTimers();
  recorder = new CheckRecorder();
  scheduler = new DesktopUpdateCheckScheduler(recorder);
});

afterEach(() => {
  vi.useRealTimers();
});

it("checks at startup and then once per period while the app stays open", async () => {
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(recorder.calls).toEqual(["automatic"]);

  await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS - 1);
  expect(recorder.calls).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(recorder.calls).toHaveLength(2);
});

it("rechecks on focus only after the throttle window", async () => {
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);

  scheduler.onFocus();
  expect(recorder.calls).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(FOCUS_INTERVAL_MS);
  scheduler.onFocus();
  await vi.advanceTimersByTimeAsync(0);
  expect(recorder.calls).toHaveLength(2);
});

it("retries a failed check twice with a bounded delay, then returns to the period", async () => {
  recorder.outcome = "failed";
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
  await vi.advanceTimersByTimeAsync(SECOND_RETRY_MS);
  expect(recorder.calls).toHaveLength(3);

  await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
  expect(recorder.calls).toHaveLength(4);
});

it("treats a thrown background check as failed and keeps scheduling", async () => {
  recorder.error = new Error("update feed unavailable");
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(recorder.calls).toHaveLength(1);

  recorder.error = undefined;
  await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
  expect(recorder.calls).toHaveLength(2);

  await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
  expect(recorder.calls).toHaveLength(3);
});

it("restarts the retry ladder after a successful check", async () => {
  recorder.outcome = "failed";
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
  recorder.outcome = "checked";
  await vi.advanceTimersByTimeAsync(SECOND_RETRY_MS);
  expect(recorder.calls).toHaveLength(3);

  recorder.outcome = "failed";
  await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
  await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
  expect(recorder.calls).toHaveLength(5);
});

it("keeps a skipped check on the normal period instead of retrying it", async () => {
  recorder.outcome = "skipped";
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS + SECOND_RETRY_MS);
  expect(recorder.calls).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
  expect(recorder.calls).toHaveLength(2);
});

it("rearms the schedule from a manual check without waiting for focus", async () => {
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  await expect(scheduler.manual()).resolves.toBe("checked");
  expect(recorder.calls).toEqual(["automatic", "manual"]);

  scheduler.onFocus();
  await vi.advanceTimersByTimeAsync(FOCUS_INTERVAL_MS);
  expect(recorder.calls).toHaveLength(2);

  await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
  expect(recorder.calls).toHaveLength(3);
});

it("runs one request at a time when focus and the period overlap", async () => {
  let release!: () => void;
  recorder.block = new Promise<void>((resolve) => {
    release = resolve;
  });
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);

  await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS);
  scheduler.onFocus();
  expect(recorder.calls).toHaveLength(1);

  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(recorder.calls).toHaveLength(1);
});

it("stops checking once the app begins to quit", async () => {
  recorder.outcome = "failed";
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  scheduler.stop();

  await vi.advanceTimersByTimeAsync(PERIODIC_INTERVAL_MS * 3);
  scheduler.onFocus();
  expect(recorder.calls).toHaveLength(1);
});
