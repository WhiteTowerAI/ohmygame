import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LimitContinuations, type LimitContinuationSnapshot } from "../src/daemon/limit-continuation.js";
import { LIMIT_RESUME_MARGIN_MS, limitResumeAt } from "../src/shared/limit-resume.js";

const now = Date.UTC(2026, 9, 26, 12, 0, 0);
const window = { id: "claude/five_hour", usedPercent: 100, windowMinutes: 300, resetsAt: now / 1000 + 60 };
const due = 60_000 + LIMIT_RESUME_MARGIN_MS;

describe("limitResumeAt", () => {
  const failedAt = now - 60_000;
  it("waits for every exhausted window the failure fell inside", () => {
    expect(limitResumeAt([window, { ...window, id: "b", usedPercent: 40, resetsAt: now / 1000 + 600 }], failedAt, now)).toBe(now + due);
    expect(limitResumeAt([window, { ...window, id: "b", windowMinutes: 10_080, resetsAt: now / 1000 + 600 }], failedAt, now)).toBe(now + 600_000 + LIMIT_RESUME_MARGIN_MS);
  });
  it("finds nothing without a future reset", () => {
    expect(limitResumeAt([{ ...window, resetsAt: now / 1000 - 60 }], failedAt, now)).toBeUndefined();
    expect(limitResumeAt([{ ...window, resetsAt: undefined }], failedAt, now)).toBeUndefined();
    expect(limitResumeAt(undefined, failedAt, now)).toBeUndefined();
  });
  it("leaves out windows it can't tie to the failure", () => {
    expect(limitResumeAt([window], now - 6 * 3600_000, now)).toBeUndefined();
    expect(limitResumeAt([{ ...window, windowMinutes: undefined }], failedAt, now)).toBeUndefined();
  });
});

describe("LimitContinuations", () => {
  let snapshot: Omit<LimitContinuationSnapshot, "send"> | undefined;
  const send = vi.fn();
  let continuations: LimitContinuations;
  const status = () => continuations.status("p", "c");
  const fail = async () => {
    continuations.changed("p", "c", true);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    send.mockReset();
    snapshot = { account: "claude-code-cli\nsystem", limits: [window], enabled: true, projectBusy: false };
    continuations = new LimitContinuations(async () => snapshot && { ...snapshot, send });
  });
  afterEach(() => {
    continuations.close();
    vi.useRealTimers();
  });

  it("sends once after the reset, without being asked or looked at", async () => {
    await fail();
    await vi.advanceTimersByTimeAsync(due - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(send).toHaveBeenCalledOnce();
    await expect(status()).resolves.toBeUndefined();
  });

  it("still sends when a new window reports during the margin", async () => {
    await fail();
    await vi.advanceTimersByTimeAsync(61_000);
    snapshot!.limits = [{ ...window, usedPercent: 2, resetsAt: Date.now() / 1000 + 18_000 }];
    continuations.limitsReported();
    await expect(status()).resolves.toEqual({ at: now + due, state: "armed" });
    await vi.advanceTimersByTimeAsync(LIMIT_RESUME_MARGIN_MS);
    expect(send).toHaveBeenCalledOnce();
  });

  it("picks up a limit report that came after the failure, with nobody looking", async () => {
    snapshot!.limits = undefined;
    await fail();
    await expect(status()).resolves.toBeUndefined();
    snapshot!.limits = [window];
    continuations.limitsReported();
    await vi.advanceTimersByTimeAsync(due);
    expect(send).toHaveBeenCalledOnce();
  });

  it("has nothing for a conversation that didn't fail", async () => {
    await expect(status()).resolves.toBeUndefined();
    continuations.skip("p", "c");
    continuations.limitsReported();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["the conversation changes", () => continuations.changed("p", "c", false)],
    ["it moved to another account", () => { snapshot!.account = "claude-code-cli\nwork"; }],
    ["it can no longer take a message", () => { snapshot = undefined; }],
  ])("sends nothing when %s", async (_name, change) => {
    await fail();
    change();
    await vi.advanceTimersByTimeAsync(due);
    expect(send).not.toHaveBeenCalled();
    await expect(status()).resolves.toBeUndefined();
  });

  it("sends nothing when the conversation changes while it is looked up", async () => {
    let finish: (value: LimitContinuationSnapshot) => void = () => {};
    const slow = vi.fn<() => Promise<LimitContinuationSnapshot | undefined>>(async () => ({ ...snapshot!, send }));
    continuations = new LimitContinuations(slow);
    await fail();
    slow.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(due);
    continuations.changed("p", "c", false);
    finish({ ...snapshot!, send });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4])("never sends or starts a timer after a change %i ticks behind the lookup", async (ticks) => {
    let finish: (value: LimitContinuationSnapshot) => void = () => {};
    const slow = vi.fn<() => Promise<LimitContinuationSnapshot | undefined>>(async () => ({ ...snapshot!, send }));
    continuations = new LimitContinuations(slow);
    const behindLookup = async () => {
      for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
      continuations.changed("p", "c", false);
      sentBeforeChange = send.mock.calls.length;
    };
    let sentBeforeChange = 0;

    // While it works out when it is due: nothing may be left ticking.
    slow.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    continuations.changed("p", "c", true);
    finish({ ...snapshot!, send });
    await behindLookup();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);

    // When it is due: a send may only come before the change.
    await fail();
    await vi.advanceTimersByTimeAsync(due - 1);
    slow.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(1);
    finish({ ...snapshot!, send });
    await behindLookup();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(sentBeforeChange);
  });

  it("keeps a newer failure when an older look comes back late", async () => {
    let finish: (value: LimitContinuationSnapshot | undefined) => void = () => {};
    const slow = vi.fn<() => Promise<LimitContinuationSnapshot | undefined>>(async () => ({ ...snapshot!, send }));
    continuations = new LimitContinuations(slow);
    await fail();
    slow.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const looking = status();
    await fail();
    finish(undefined);
    await expect(looking).resolves.toBeUndefined();
    await expect(status()).resolves.toMatchObject({ state: "armed" });
  });

  it("follows the setting up to the moment it is due", async () => {
    await fail();
    snapshot!.enabled = false;
    await expect(status()).resolves.toEqual({ at: now + due, state: "off" });
    snapshot!.enabled = true;
    await vi.advanceTimersByTimeAsync(due);
    expect(send).toHaveBeenCalledOnce();

    send.mockClear();
    snapshot!.limits = [{ ...window, resetsAt: Date.now() / 1000 + 60 }];
    await fail();
    snapshot!.enabled = false;
    await vi.advanceTimersByTimeAsync(due);
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves a message being written to its author", async () => {
    await fail();
    continuations.skip("p", "c");
    await expect(status()).resolves.toEqual({ at: now + due, state: "skipped" });
    await vi.advanceTimersByTimeAsync(due);
    expect(send).not.toHaveBeenCalled();
  });

  it("waits while another conversation holds the project", async () => {
    await fail();
    snapshot!.projectBusy = true;
    await vi.advanceTimersByTimeAsync(due + 60_000);
    expect(send).not.toHaveBeenCalled();
    snapshot!.projectBusy = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledOnce();
  });

  it("schedules again when the continue stops at a later limit, and only one timer stands", async () => {
    await fail();
    await fail();
    await vi.advanceTimersByTimeAsync(due);
    expect(send).toHaveBeenCalledOnce();
    snapshot!.limits = [{ ...window, resetsAt: Date.now() / 1000 + 60 }];
    await fail();
    await vi.advanceTimersByTimeAsync(due);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not schedule again when the only report is of a reset that has passed", async () => {
    await fail();
    await vi.advanceTimersByTimeAsync(due);
    await fail();
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(send).toHaveBeenCalledOnce();
  });

  it("survives a send that is refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    send.mockImplementationOnce(() => { throw new Error("Finish the plan first"); });
    await fail();
    await vi.advanceTimersByTimeAsync(due);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    await expect(status()).resolves.toBeUndefined();
  });

  it("ends every schedule on close", async () => {
    await fail();
    continuations.close();
    await vi.advanceTimersByTimeAsync(due);
    expect(send).not.toHaveBeenCalled();
  });
});
