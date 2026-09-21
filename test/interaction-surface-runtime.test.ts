import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";

type RuntimeSession = {
  active: boolean;
  commands: unknown[];
  completed: boolean;
  controller: AbortController;
  instanceId: string;
  lifecycle: { paused: boolean };
  mode: "runtime";
  outcomes: string[];
  run: (context: unknown) => Promise<string>;
  started: boolean;
  timeout?: { durationMs: number; outcome: string };
  variableDefinitions: unknown[];
  variables: Record<string, unknown>;
};

let runtimeSource = "";

beforeAll(async () => {
  runtimeSource = await readFile(new URL("../public/interaction-surface.html", import.meta.url), "utf8");
});

describe("Interaction surface runtime", () => {
  it("pauses and resumes its deadline", async () => {
    vi.useFakeTimers();
    try {
      const createLifecycle = loadRuntimeFunction<(paused: boolean) => { setPaused(paused: boolean): void }>("createLifecycle");
      const waitForTimeout = loadRuntimeFunction<(duration: number, signal: AbortSignal, lifecycle: ReturnType<typeof createLifecycle>) => Promise<void>>("waitForTimeout");
      const lifecycle = createLifecycle(false);
      let settled = false;
      const deadline = waitForTimeout(1_000, new AbortController().signal, lifecycle).then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(400);
      lifecycle.setPaused(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(false);

      lifecycle.setPaused(false);
      await vi.advanceTimersByTimeAsync(599);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await deadline;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards commands on timeout and ignores late completion", async () => {
    const deadline = deferred<void>();
    const execution = deferred<string>();
    const messages: CompletionMessage[] = [];
    const current = runtimeSession(async () => {
      current.commands.push({ type: "set-variable" });
      return execution.promise;
    }, { durationMs: 1_000, outcome: "timeout" });
    const complete = loadComplete(current, messages);
    const start = loadStart(current, () => deadline.promise, complete);

    start(current);
    await flushPromises();
    deadline.resolve();
    await flushPromises();
    execution.resolve("success");
    await flushPromises();

    expect(messages).toEqual([{ result: "timeout", commands: [], source: "timeout" }]);
    expect(current.controller.signal.aborted).toBe(true);
  });

  it("commits commands once when code completes before the deadline", async () => {
    const deadline = deferred<void>();
    const messages: CompletionMessage[] = [];
    const current = runtimeSession(async () => {
      current.commands.push({ type: "set-variable" });
      return "success";
    }, { durationMs: 1_000, outcome: "timeout" });
    const complete = loadComplete(current, messages);
    const start = loadStart(current, () => deadline.promise, complete);

    start(current);
    await flushPromises();
    deadline.resolve();
    await flushPromises();

    expect(messages).toEqual([{ result: "success", commands: [{ type: "set-variable" }], source: "behavior" }]);
  });
});

function loadStart(current: RuntimeSession, waitForTimeout: () => Promise<void>, complete: (current: RuntimeSession, result: string, commands: unknown[], source: CompletionMessage["source"]) => void) {
  return loadRuntimeFunction<(current: RuntimeSession) => void>("start", {
    session: current,
    document: {},
    waitForTimeout,
    createUi: () => ({}),
    createGame: () => ({}),
    complete,
    reportError: (_current: RuntimeSession, error: unknown) => { throw error; },
  });
}

type CompletionMessage = { result: string; commands: unknown[]; source: "behavior" | "timeout" };

function loadComplete(current: RuntimeSession, messages: CompletionMessage[]) {
  return loadRuntimeFunction<(current: RuntimeSession, result: string, commands: unknown[], source: CompletionMessage["source"]) => void>("complete", {
    session: current,
    post: (_instanceId: string, _type: string, payload: CompletionMessage) => messages.push(payload),
  });
}

function runtimeSession(run: RuntimeSession["run"], timeout?: RuntimeSession["timeout"]): RuntimeSession {
  return {
    active: true,
    commands: [],
    completed: false,
    controller: new AbortController(),
    instanceId: "test",
    lifecycle: { paused: false },
    mode: "runtime",
    outcomes: ["success", "timeout"],
    run,
    started: false,
    timeout,
    variableDefinitions: [],
    variables: {},
  };
}

function loadRuntimeFunction<T>(name: string, dependencies: Record<string, unknown> = {}): T {
  const source = extractFunction(runtimeSource, name);
  const names = Object.keys(dependencies);
  return Function(...names, `return (${source});`)(...Object.values(dependencies)) as T;
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing runtime function: ${name}`);
  const body = source.indexOf("{", start);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Incomplete runtime function: ${name}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
