import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ProjectNaming } from "../src/daemon/project-naming.js";
import { ProjectManager } from "../src/daemon/projects.js";
import type { RuntimeModel } from "../src/daemon/agent.js";

const directories: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

async function directory() {
  const result = await mkdtemp(path.join(tmpdir(), "ohmygame-naming-"));
  directories.push(result);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("background project naming", () => {
  it("resolves the conversation model through the runtime and sends the saved rename event", async () => {
    const model: RuntimeModel = {
      provider: "fixture",
      id: "text",
      name: "Fixture text",
      api: "openai-completions",
      baseUrl: "https://fixture.example/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 32_000,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const completeSimple = vi.fn(
      async (..._args: Parameters<ModelRuntime["completeSimple"]>) => ({
        role: "assistant",
        content: [{ type: "text", text: '{"name":"月球花园"}' }],
        stopReason: "stop",
      }),
    );
    const runtime = {
      getAvailable: async () => [model],
      getModel: () => model,
      getProvider: () => ({ name: "Fixture" }),
      hasConfiguredAuth: () => true,
      completeSimple,
    } as unknown as ModelRuntime;
    const app = createApp({
      dataDirectory: await directory(),
      createModelRuntime: async () => runtime,
      createSession: async () => ({
        messages: [],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    cleanups.push(() => app.close());
    const project = (
      await app.inject({ method: "POST", url: "/projects", payload: {} })
    ).json();
    const conversation = (
      await app.inject({
        method: "POST",
        url: `/projects/${project.id}/conversations`,
        payload: { model: { provider: model.provider, id: model.id } },
      })
    ).json();
    expect(conversation.id).toBeDefined();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
          payload: { prompt: "制作月球种植游戏" },
        })
      ).statusCode,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect(
        (await app.inject({ method: "GET", url: "/projects" })).json()[0],
      ).toMatchObject({ name: "月球花园", nameSource: "ai" }),
    );
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(completeSimple.mock.calls[0]?.[0]).toBe(model);
    expect(
      (await app.inject({ method: "GET", url: "/projects/activity" })).json()
        .names,
    ).toEqual([{ id: project.id, name: "月球花园", nameSource: "ai" }]);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    try {
      const response = await fetch(
        `${address}/projects/${project.id}/events?cursor=0`,
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(2_000),
          ]),
        },
      );
      const reader = response.body!.getReader();
      let events = "";
      while (!events.includes('"type":"project.renamed"')) {
        const { value, done } = await reader.read();
        if (done) break;
        events += new TextDecoder().decode(value);
      }
      expect(events).toContain('"type":"project.renamed"');
      expect(events).toContain('"name":"月球花园","nameSource":"ai"');
    } finally {
      controller.abort();
    }
  });
  it("deduplicates concurrent prompts and publishes a single saved name", async () => {
    const manager = new ProjectManager(await directory());
    const project = await manager.create(undefined, "general");
    const result = deferred<string>();
    const generate = vi.fn(async () => result.promise);
    const renamed = vi.fn();
    const naming = new ProjectNaming(manager, generate, renamed);
    cleanups.push(() => naming.close());
    const model = { provider: "fixture", id: "text" };
    naming.start(project, "Make a moon garden game", model);
    naming.start(project, "Add plants", model);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      "Make a moon garden game",
      model,
      expect.any(AbortSignal),
    );
    result.resolve("Moon Garden");
    await vi.waitFor(() => expect(renamed).toHaveBeenCalledTimes(1));
    expect(renamed.mock.calls[0]![0]).toMatchObject({
      name: "Moon Garden",
      nameSource: "ai",
    });
    naming.start(project, "Change all the plants", model);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("preserves a manual rename while the provider is still answering", async () => {
    const manager = new ProjectManager(await directory());
    const project = await manager.create(undefined, "general");
    const result = deferred<string>();
    const save = vi.spyOn(manager, "nameAutomatically");
    const naming = new ProjectNaming(
      manager,
      async () => result.promise,
      vi.fn(),
    );
    cleanups.push(() => naming.close());
    naming.start(project, "Build a forest game", undefined);
    await manager.rename(project.id, "My Forest");
    result.resolve("AI Forest");
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledWith(project.id, "AI Forest"),
    );
    expect(project).toMatchObject({ name: "My Forest", nameSource: "manual" });
  });

  it("defers empty prompts and retries after no name or a provider failure", async () => {
    const manager = new ProjectManager(await directory());
    const project = await manager.create(undefined, "general");
    const generate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue("Forest Adventure");
    const renamed = vi.fn();
    const naming = new ProjectNaming(manager, generate, renamed);
    cleanups.push(() => naming.close());
    naming.start(project, " ", undefined);
    expect(generate).not.toHaveBeenCalled();
    naming.start(project, "Hi", undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    naming.start(project, "Build a forest game", undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(project.nameSource).toBe("default");
    naming.start(project, "Explore the forest", undefined);
    await vi.waitFor(() => expect(renamed).toHaveBeenCalledTimes(1));
    expect(project.name).toBe("Forest Adventure");
  });

  it("ignores results after timeout even when the provider ignores cancellation", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const manager = new ProjectManager(await directory());
    const project = await manager.create(undefined, "general");
    const result = deferred<string>();
    const renamed = vi.fn();
    const naming = new ProjectNaming(
      manager,
      async () => result.promise,
      renamed,
    );
    naming.start(project, "Build a game", undefined);
    timeout.abort();
    await naming.close();
    result.resolve("Too Late");
    await Promise.resolve();
    expect(project.nameSource).toBe("default");
    expect(renamed).not.toHaveBeenCalled();
  });

  it("accepts the agent turn before naming finishes and leaves explicitly named projects alone", async () => {
    const result = deferred<string>();
    const generate = vi.fn(async () => result.promise);
    const prompt = vi.fn(async () => {});
    const app = createApp({
      dataDirectory: await directory(),
      generateProjectName: generate,
      createSession: async () => ({
        messages: [],
        prompt,
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
      }),
    });
    cleanups.push(() => app.close());
    const project = (
      await app.inject({ method: "POST", url: "/projects", payload: {} })
    ).json();
    const conversation = (
      await app.inject({
        method: "POST",
        url: `/projects/${project.id}/conversations`,
      })
    ).json();
    const accepted = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
      payload: { prompt: "制作月球种植游戏" },
    });
    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      (await app.inject({ method: "GET", url: "/projects" })).json()[0]
        .nameSource,
    ).toBe("default");
    result.resolve("月球花园");
    await vi.waitFor(async () =>
      expect(
        (await app.inject({ method: "GET", url: "/projects" })).json()[0],
      ).toMatchObject({ name: "月球花园", nameSource: "ai" }),
    );
    const manual = (
      await app.inject({
        method: "POST",
        url: "/projects",
        payload: { name: "My Project" },
      })
    ).json();
    const manualConversation = (
      await app.inject({
        method: "POST",
        url: `/projects/${manual.id}/conversations`,
      })
    ).json();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/projects/${manual.id}/conversations/${manualConversation.id}/turns`,
          payload: { prompt: "Build a forest game" },
        })
      ).statusCode,
    ).toBe(202);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
