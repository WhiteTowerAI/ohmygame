import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledMessages, type ScheduledSend } from "../src/daemon/scheduled-messages.js";
import type { ScheduledMessage } from "../src/shared/contracts.js";

const START = Date.UTC(2026, 10, 3, 12);
const MINUTE = 60_000;

describe("ScheduledMessages", () => {
  let root: string;
  let open: ScheduledMessages[];
  let sent: string[];
  let busy: boolean;
  let gone: boolean;
  let changes: ScheduledMessage[][];

  const send = (prompt: string) => () => {
    if (busy) return false;
    sent.push(prompt);
    return true;
  };
  const create = async (lookup: ConstructorParameters<typeof ScheduledMessages>[1] = async (_p, _c, prompt) => gone ? undefined : send(prompt)) => {
    const store = new ScheduledMessages(root, lookup, (_p, _c, messages) => changes.push(messages));
    open.push(store);
    await store.load();
    return store;
  };
  const list = (store: ScheduledMessages) => store.list("p", "c");

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "scheduled-messages-"));
    open = [];
    sent = [];
    busy = false;
    gone = false;
    changes = [];
    vi.useFakeTimers({ now: START, toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(async () => {
    await Promise.all(open.map((store) => store.close()));
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it("sends at its time and not before, then forgets it", async () => {
    const store = await create();
    store.add("p", "c", "Go", START + 5 * MINUTE);
    expect(changes.at(-1)).toMatchObject([{ prompt: "Go", at: START + 5 * MINUTE }]);
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["Go"]);
    expect(list(store)).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
  });

  it("reaches a time further off than a timer can wait", async () => {
    const store = await create();
    store.add("p", "c", "Go", START + 40 * 24 * 60 * MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(40 * 24 * 60 * MINUTE);
    expect(sent).toEqual(["Go"]);
  });

  it("waits while it can't go, then sends in the order they came due", async () => {
    const store = await create();
    busy = true;
    store.add("p", "c", "Second", START + 2 * MINUTE);
    store.add("p", "c", "First", START + MINUTE);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sent).toEqual([]);
    expect(list(store).map((message) => message.prompt)).toEqual(["First", "Second"]);
    busy = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toEqual(["First", "Second"]);
  });

  it("does not delay another message's time for one that is waiting", async () => {
    const store = await create();
    busy = true;
    store.add("p", "c", "Waiting", START);
    store.add("p", "c", "Soon", START + 1_000);
    busy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual(["Waiting", "Soon"]);
  });

  it("tries again when sending throws, and sends once", async () => {
    let refuse = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await create(async (_p, _c, prompt) => () => {
      if (refuse) throw new Error("Wait for the agent");
      sent.push(prompt);
      return true;
    });
    store.add("p", "c", "Go", START + MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(list(store)).toHaveLength(1);
    refuse = false;
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sent).toEqual(["Go"]);
    warn.mockRestore();
  });

  it("tries again when the lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lookup = vi.fn<ConstructorParameters<typeof ScheduledMessages>[1]>().mockRejectedValueOnce(new Error("disk")).mockImplementation(async (_p, _c, prompt) => send(prompt));
    const store = await create(lookup);
    store.add("p", "c", "Go", START + MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE + 30_000);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(sent).toEqual(["Go"]);
    expect(list(store)).toEqual([]);
    warn.mockRestore();
  });

  it("drops a message whose conversation is gone", async () => {
    const store = await create();
    gone = true;
    store.add("p", "c", "Go", START + MINUTE);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sent).toEqual([]);
    expect(list(store)).toEqual([]);
  });

  it("removes a message only from its own conversation", async () => {
    const store = await create();
    store.add("p", "c", "Go", START + MINUTE);
    const { id } = list(store)[0];
    expect(store.remove("p", "other", id)).toBe(false);
    expect(store.remove("p", "c", id)).toBe(true);
    expect(store.remove("p", "c", id)).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sent).toEqual([]);
  });

  it.each(["removed", "closed"])("sends nothing when %s during the lookup", async (how) => {
    let answer: (value: ScheduledSend) => void = () => {};
    const store = await create(() => new Promise((resolve) => { answer = resolve; }));
    store.add("p", "c", "Go", START + MINUTE);
    const { id } = list(store)[0];
    await vi.advanceTimersByTimeAsync(MINUTE);
    if (how === "removed") store.remove("p", "c", id);
    else await store.close();
    answer(send("Go"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
  });

  it("keeps a message over a restart, and sends it at its time", async () => {
    const first = await create();
    first.add("p", "c", "Go", START + 5 * MINUTE);
    await first.close();
    const second = await create();
    expect(list(second)).toMatchObject([{ prompt: "Go" }]);
    expect(list(second)[0].missed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sent).toEqual(["Go"]);
  });

  it("never sends on startup what came due while closed, and leaves it to the person", async () => {
    const first = await create();
    first.add("p", "c", "Go", START + MINUTE);
    await first.close();
    vi.setSystemTime(START + 60 * MINUTE);
    const second = await create();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sent).toEqual([]);
    expect(list(second)).toMatchObject([{ prompt: "Go", missed: true }]);
    second.remove("p", "c", list(second)[0].id);
    await second.close();
    await expect(readFile(path.join(root, "scheduled-messages.json"), "utf8")).resolves.toContain('"messages": []');
  });

  it("reports a damaged file and holds nothing from it", async () => {
    const good = { id: "a", projectId: "p", conversationId: "c", prompt: "Go", at: START + MINUTE };
    await writeFile(path.join(root, "scheduled-messages.json"), JSON.stringify({ messages: [good, null] }));
    const store = new ScheduledMessages(root, async () => undefined, () => {});
    await expect(store.load()).rejects.toThrow();
    expect(list(store)).toEqual([]);
    await writeFile(path.join(root, "scheduled-messages.json"), "{ nope");
    await expect(store.load()).rejects.toThrow(SyntaxError);
  });
});
