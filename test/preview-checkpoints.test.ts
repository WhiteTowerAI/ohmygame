import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { CheckpointStore } from "../src/daemon/checkpoints.js";
import type {
  ConversationDetail,
  ProjectState,
} from "../src/shared/contracts.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function reply(content: AssistantMessage["content"], toolUse = false) {
  const output = createAssistantMessageEventStream();
  queueMicrotask(() =>
    output.push({
      type: "done",
      reason: toolUse ? "toolUse" : "stop",
      message: {
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        stopReason: toolUse ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    }),
  );
  return output;
}

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-preview-checkpoints-"),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const agentDirectory = path.join(directory, "agent");
  await mkdir(agentDirectory);
  await writeFile(
    path.join(agentDirectory, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDirectory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey("anthropic", "test");
  runtime.streamSimple = () => reply([{ type: "text", text: "Hi" }]);
  const model = runtime.getModels("anthropic")[0]!;
  const app = createApp({
    dataDirectory: directory,
    piAgentDirectory: agentDirectory,
    createModelRuntime: async () => runtime,
  });
  cleanups.push(() => app.close());
  const project = (
    await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Preview checkpoints" },
    })
  ).json<ProjectState>();
  const conversationResponse = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/conversations`,
    payload: { model: { provider: model.provider, id: model.id } },
  });
  expect(conversationResponse.statusCode, conversationResponse.body).toBe(201);
  const conversationUrl = `/projects/${project.id}/conversations/${conversationResponse.json().id}`;
  const readProject = async () =>
    (
      await app.inject({ method: "GET", url: `/projects/${project.id}` })
    ).json<ProjectState>();
  const chat = async (prompt = "hi") => {
    const started = await app.inject({
      method: "POST",
      url: `${conversationUrl}/turns`,
      payload: { prompt },
    });
    expect(started.statusCode, started.body).toBe(202);
    return vi.waitFor(async () => {
      const detail = (
        await app.inject({ method: "GET", url: conversationUrl })
      ).json<ConversationDetail>();
      expect(detail.agent.status, JSON.stringify(detail.agent)).toBe("idle");
      const user = detail.turns
        .at(-1)
        ?.items.find((item) => item.type === "userMessage");
      if (user?.type !== "userMessage" || !user.checkpointId)
        throw new Error("Waiting for the turn checkpoint");
      expect(user.text).toBe(prompt);
      expect(user.changes).toBeDefined();
      return user;
    });
  };
  const lease = () =>
    app.inject({
      method: "PUT",
      url: `/projects/${project.id}/preview/leases/test-editor`,
      payload: { automatic: true },
    });
  return { app, project, runtime, conversationUrl, readProject, chat, lease };
}

it.each(["static", "command"] as const)(
  "keeps a running %s preview through a text-only turn and a diff read",
  async (previewMode) => {
    const { app, project, conversationUrl, readProject, chat, lease } =
      await fixture();
    await writeFile(
      path.join(project.workspacePath, "index.html"),
      "<p>Game</p>",
    );
    await writeFile(
      path.join(project.workspacePath, "server.mjs"),
      "import {createServer} from 'node:http';createServer((req,res)=>res.end(String(process.pid))).listen(Number(process.env.PORT),'127.0.0.1');",
    );
    const settings = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}/settings/run`,
      payload: {
        startupDirectory: ".",
        startupScript: "dev",
        previewPath: "/",
        previewViewport: "fit",
        previewMode,
        previewCommand: `'${process.execPath.replaceAll("'", "'\\''")}' server.mjs`,
      },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    const started = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/preview`,
    });
    expect(started.statusCode, started.body).toBe(200);
    await lease();
    const before = (await readProject()).preview;
    const content =
      previewMode === "command"
        ? await (await fetch(before.url!)).text()
        : expect.stringContaining("<p>Game</p>");
    const originalSnapshot = CheckpointStore.prototype.snapshot;
    const snapshot = vi.spyOn(CheckpointStore.prototype, "snapshot");
    snapshot.mockImplementation(async function (this: CheckpointStore, state) {
      expect((await readProject()).preview).toMatchObject({
        status: "ready",
        url: before.url,
        revision: before.revision,
      });
      expect(await (await fetch(before.url!)).text()).toEqual(content);
      return originalSnapshot.call(this, state);
    });
    const turn = await chat();
    expect(turn.changes).toMatchObject({ files: 0 });
    expect(snapshot).toHaveBeenCalledTimes(2);
    const changes = await app.inject({
      method: "GET",
      url: `${conversationUrl}/checkpoints/${turn.checkpointId}/changes`,
    });
    expect(changes.statusCode, changes.body).toBe(200);
    expect(changes.json()).toEqual({ changes: [] });
    expect(snapshot).toHaveBeenCalledTimes(3);
    expect((await readProject()).preview).toEqual(before);
    expect(await (await fetch(before.url!)).text()).toEqual(content);
  },
);

it.each(["waiting", "manual"] as const)(
  "preserves the %s preview state through a text-only turn",
  async (state) => {
    const { app, project, readProject, chat, lease } = await fixture();
    await lease();
    if (state === "manual") {
      await app.inject({
        method: "DELETE",
        url: `/projects/${project.id}/preview`,
      });
    }
    const before = (await readProject()).preview;
    expect(before).toMatchObject(
      state === "manual"
        ? { status: "stopped", stopReason: "manual" }
        : { status: "waiting" },
    );
    const turn = await chat();
    expect(turn.changes).toMatchObject({ files: 0 });
    expect((await readProject()).preview).toEqual(before);
  },
);

it("lets a preview finish starting while a text-only turn takes snapshots", async () => {
  const { app, project, readProject, chat, lease } = await fixture();
  await writeFile(
    path.join(project.workspacePath, "server.mjs"),
    "import {existsSync} from 'node:fs';import {createServer} from 'node:http';const timer=setInterval(()=>{if(!existsSync('.listen'))return;clearInterval(timer);createServer((req,res)=>res.end('Ready')).listen(Number(process.env.PORT),'127.0.0.1');},25);",
  );
  const settings = await app.inject({
    method: "PUT",
    url: `/projects/${project.id}/settings/run`,
    payload: {
      startupDirectory: ".",
      startupScript: "dev",
      previewPath: "/",
      previewViewport: "fit",
      previewMode: "command",
      previewCommand: `'${process.execPath.replaceAll("'", "'\\''")}' server.mjs`,
    },
  });
  expect(settings.statusCode, settings.body).toBe(200);
  await lease();
  await vi.waitFor(async () =>
    expect((await readProject()).preview.phase).toBe("connecting"),
  );
  const before = (await readProject()).preview;
  try {
    const turn = await chat();
    expect(turn.changes).toMatchObject({ files: 0 });
    expect((await readProject()).preview).toEqual(before);
  } finally {
    // A hidden gate releases this launch without changing the watched source files.
    await writeFile(path.join(project.workspacePath, ".listen"), "");
  }
  await vi.waitFor(async () =>
    expect((await readProject()).preview).toMatchObject({
      status: "ready",
      revision: 1,
    }),
  );
  expect(await (await fetch((await readProject()).preview.url!)).text()).toBe(
    "Ready",
  );
});

it("automatically starts a preview when an agent creates browser output", async () => {
  const { project, runtime, readProject, chat, lease } = await fixture();
  await lease();
  let calls = 0;
  runtime.streamSimple = () =>
    calls++ === 0
      ? reply(
          [
            {
              type: "toolCall",
              id: "write-page",
              name: "write",
              arguments: { path: "index.html", content: "<p>New game</p>" },
            },
          ],
          true,
        )
      : reply([{ type: "text", text: "Created" }]);
  const turn = await chat("Create a game");
  expect(turn.changes).toMatchObject({ files: 1 });
  await vi.waitFor(async () =>
    expect((await readProject()).preview.status).toBe("ready"),
  );
  expect(
    await (await fetch((await readProject()).preview.url!)).text(),
  ).toContain("New game");
});
