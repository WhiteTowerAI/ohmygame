import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConversationManager } from "../src/daemon/conversations.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import * as environment from "../src/daemon/agent-runtimes/environment.js";
import {
  isAgentRuntimeId,
  type AgentRuntimeStatus,
} from "../src/shared/agent-runtimes.js";
import type { AgentModelCatalog, ConversationDetail, ConversationSummary, ProjectState } from "../src/shared/contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  // Routes use explicit fixture executables. Real shell startup belongs in the
  // binary discovery tests and must not consume the slow-model timeout here.
  vi.spyOn(environment, "loginShellPath").mockResolvedValue(undefined);
});
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
  }
});

// Windows starts only .exe programs, so it cannot run these script stand-ins, and
// discovery ignores them there (see docs/agent-runtimes.md).
/** A stand-in for the `claude` executable: its version, its sign-in and its model list. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "player@example.com" })); process.exit(0); }
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "control_request") return;
  const response = message.request.subtype === "list_models"
    ? { models: [{ value: "sonnet", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "high"] }, { value: "haiku", displayName: "Haiku" }] }
    : {};
  process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } }) + "\\n");
});
`;

async function start(source = FAKE_CLAUDE) {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-agent-routes-"),
  );
  cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const claude = path.join(dataDirectory, "fake-claude");
  await writeFile(claude, source);
  await chmod(claude, 0o755);
  const app = createApp({
    dataDirectory,
    piAgentDirectory: path.join(dataDirectory, "pi-agent"),
    accessToken: "app-token",
  });
  cleanup.push(() => app.close());
  await app.ready();
  const call = async <T>(
    method: string,
    url: string,
    payload?: unknown,
    token = "app-token",
  ) => {
    const response = await app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    return {
      status: response.statusCode,
      body: (response.body ? JSON.parse(response.body) : undefined) as T,
    };
  };
  // Only the fake runs: the other agents point at nothing, whatever is installed on this computer.
  await call("PATCH", "/agent-runtimes/codex-cli", {
    binaryPath: path.join(dataDirectory, "missing-codex"),
  });
  await call("PATCH", "/agent-runtimes/opencode-cli", {
    binaryPath: path.join(dataDirectory, "missing-opencode"),
  });
  return { app, call, claude };
}

describe("coding agent routes", () => {
  it.skipIf(process.platform === "win32")("persists the optional media step and completes setup using only a CLI", async () => {
    const { call, claude } = await start();
    expect((await call("PUT", "/settings/onboarding", { status: "pending", step: "media" })).status).toBe(200);
    expect((await call<{ step: string }>("GET", "/settings/onboarding")).body.step).toBe("media");
    expect((await call("PUT", "/settings/onboarding", { status: "completed", step: "media" })).status).toBe(409);
    await call("PATCH", "/agent-runtimes/claude-code-cli", { binaryPath: claude, enabled: true });
    await call("PUT", "/models/default", { model: { provider: "claude-code-cli", id: "sonnet" }, nativeReasoningLevel: "high" });
    expect((await call("PUT", "/settings/onboarding", { status: "completed", step: "media" })).status).toBe(200);
    await call("PATCH", "/agent-runtimes/claude-code-cli", { enabled: false });
    expect((await call("PUT", "/settings/onboarding", { status: "completed", step: "media" })).status).toBe(409);
  });

  it("branches a completed stored response through the API and rejects invalid targets", async () => {
    const { call } = await start();
    const project = (await call<ProjectState>("POST", "/projects", {})).body;
    const conversations = new ConversationManager();
    const source = await conversations.create(project);
    const session = conversations.open(project, source);
    session.appendMessage({ role: "user", content: "Question", timestamp: Date.now() } as never);
    const entryId = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop", timestamp: Date.now() } as never);
    const base = `/projects/${project.id}/conversations/${source.summary.id}`;
    const detail = (await call<ConversationDetail>("GET", base)).body;
    expect(detail.turns.flatMap((turn) => turn.items).find((item) => item.type === "agentMessage")).toMatchObject({ branchEntryId: entryId });
    const branched = await call<ConversationSummary>("POST", `${base}/branch`, { entryId });
    expect(branched.status).toBe(201);
    expect(branched.body.id).not.toBe(source.summary.id);
    expect(branched.body.messageCount).toBe(2);
    expect((await call("POST", `${base}/branch`, { entryId: "missing" })).status).toBe(400);
    expect((await call("POST", `${base}/branch`, {})).status).toBe(400);
    expect((await call("POST", `/projects/${project.id}/conversations/missing/branch`, { entryId })).status).toBe(404);
  });
  it.skipIf(process.platform === "win32")("accepts models returned by Claude initialize without requesting list_models", async () => {
    const { call, claude } = await start(
      FAKE_CLAUDE.replace('=== "list_models"', '=== "initialize"'),
    );
    await call("PATCH", "/agent-runtimes/claude-code-cli", {
      binaryPath: claude,
      enabled: true,
    });
    const catalog = await call<AgentModelCatalog>("GET", "/models?runtimes=1");
    expect(
      catalog.body.models
        .filter((model) => isAgentRuntimeId(model.provider))
        .map((model) => model.id),
    ).toEqual(["sonnet", "haiku"]);
  });

  it.skipIf(process.platform === "win32")("keeps arbitrary native efforts and defaults out of Pi settings and unrelated models", async () => {
    const { call, claude } = await start(
      FAKE_CLAUDE.replace(
        '["low", "high"]',
        '["low", "high", "balanced-custom"]',
      ),
    );
    await call("PATCH", "/agent-runtimes/claude-code-cli", {
      binaryPath: claude,
      enabled: true,
    });
    expect(
      (
        await call("PUT", "/models/default", {
          model: { provider: "claude-code-cli", id: "sonnet" },
          nativeReasoningLevel: "balanced-custom",
        })
      ).status,
    ).toBe(204);
    const catalog = await call<AgentModelCatalog>("GET", "/models?runtimes=1");
    expect(catalog.body.defaultNativeReasoningLevel).toBe("balanced-custom");
    const plain = await call<AgentModelCatalog>("GET", "/models");
    expect(plain.body.defaultModel?.provider).not.toBe("claude-code-cli");
    const project = await call<{ id: string }>("POST", "/projects", {
      name: "Native defaults",
      type: "general",
    });
    const created = await call<{ id: string }>(
      "POST",
      `/projects/${project.body.id}/conversations`,
      {},
    );
    const base = `/projects/${project.body.id}/conversations/${created.body.id}`;
    expect(
      (await call<{ settings: unknown }>("GET", base)).body.settings,
    ).toEqual({
      model: { provider: "claude-code-cli", id: "sonnet" },
      nativeReasoningLevel: "balanced-custom",
    });
    expect(
      (await call("PUT", base + "/reasoning", { level: "balanced-custom" }))
        .status,
    ).toBe(200);
    expect(
      (await call("PUT", base + "/reasoning", { level: "not-supported" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST", `/projects/${project.body.id}/conversations`, {
          model: { provider: "claude-code-cli", id: "haiku" },
        })
      ).status,
    ).toBe(201);
    await call("PATCH", "/agent-runtimes/claude-code-cli", { enabled: false });
    const fallback = await call<{ id: string }>(
      "POST",
      `/projects/${project.body.id}/conversations`,
      {},
    );
    expect(
      (
        await call<{ settings: { model?: { provider: string } } }>(
          "GET",
          `/projects/${project.body.id}/conversations/${fallback.body.id}`,
        )
      ).body.settings.model?.provider,
    ).not.toBe("claude-code-cli");
  });

  it.skipIf(process.platform === "win32")("preserves stored native effort while model discovery is still loading on reload", async () => {
    const responseLine = FAKE_CLAUDE.split("\n").find((line) =>
      line.includes("process.stdout.write"),
    )!;
    const slow = FAKE_CLAUDE.replace(
      responseLine,
      `setTimeout(() => { ${responseLine} }, 2400);`,
    );
    const { call, claude } = await start(slow);
    await call("PATCH", "/agent-runtimes/claude-code-cli", {
      binaryPath: claude,
      enabled: true,
    });
    const project = await call<{ id: string }>("POST", "/projects", {
      name: "Slow native models",
      type: "general",
    });
    const created = await call<{ id: string }>(
      "POST",
      `/projects/${project.body.id}/conversations`,
      {
        model: { provider: "claude-code-cli", id: "sonnet" },
        nativeReasoningLevel: "high",
      },
    );
    await call("POST", "/agent-runtimes/claude-code-cli/recheck");
    const loaded = await call<{ settings: { nativeReasoningLevel?: string } }>(
      "GET",
      `/projects/${project.body.id}/conversations/${created.body.id}`,
    );
    expect(loaded.body.settings.nativeReasoningLevel).toBe("high");
  }, 15_000);

  it.skipIf(process.platform === "win32")("reports each agent's installation, sign-in and billing, and keeps the person's choices", async () => {
    const { call, claude } = await start();
    const updated = await call<AgentRuntimeStatus>(
      "PATCH",
      "/agent-runtimes/claude-code-cli",
      { binaryPath: claude, enabled: true },
    );
    expect(updated.body).toMatchObject({
      id: "claude-code-cli",
      installed: true,
      binaryPath: claude,
      version: "2.1.300",
      auth: {
        status: "signed-in",
        billing: "subscription",
        account: "player@example.com",
      },
      enabled: true,
      diagnostics: [],
    });
    const statuses = await call<AgentRuntimeStatus[]>("GET", "/agent-runtimes");
    expect(
      statuses.body.map((status) => [status.id, status.installed]),
    ).toEqual([
      ["claude-code-cli", true],
      ["codex-cli", false],
      ["opencode-cli", false],
    ]);
    expect(statuses.body[1]!.diagnostics[0]).toMatchObject({
      code: "invalid-executable",
    });
    expect(
      (
        await call("PATCH", "/agent-runtimes/claude-code-cli", {
          binaryPath: "relative/claude",
        })
      ).status,
    ).toBe(400);
    // Node cannot start Windows command scripts, such as npm shims, without a shell.
    expect(
      (
        await call("PATCH", "/agent-runtimes/claude-code-cli", {
          binaryPath: path.join(tmpdir(), "claude.cmd"),
        })
      ).status,
    ).toBe(400);
    expect(
      (await call("PATCH", "/agent-runtimes/unknown-cli", { enabled: false }))
        .status,
    ).toBe(404);
    expect(updated.body).not.toHaveProperty("isolateUserConfig");
    expect(updated.body).not.toHaveProperty("partialIsolation");
  });

  it.skipIf(process.platform === "win32")("lists an agent's models only for conversations, and starts conversations with them", async () => {
    const { call, claude } = await start();
    await call("PATCH", "/agent-runtimes/claude-code-cli", {
      binaryPath: claude,
      enabled: true,
    });
    const plain = await call<AgentModelCatalog>("GET", "/models");
    expect(
      plain.body.models.some((model) => isAgentRuntimeId(model.provider)),
    ).toBe(false);
    const withAgents = await call<AgentModelCatalog>(
      "GET",
      "/models?runtimes=1",
    );
    expect(
      withAgents.body.models.filter((model) =>
        isAgentRuntimeId(model.provider),
      ),
    ).toEqual([
      {
        provider: "claude-code-cli",
        id: "sonnet",
        name: "Sonnet",
        providerName: "Claude Code",
        reasoningLevels: [],
        nativeReasoningLevels: ["low", "high"],
      },
      {
        provider: "claude-code-cli",
        id: "haiku",
        name: "Haiku",
        providerName: "Claude Code",
        reasoningLevels: [],
        nativeReasoningLevels: [],
      },
    ]);

    const project = await call<{ id: string }>("POST", "/projects", {
      name: "Game",
      type: "general",
    });
    expect(
      (
        await call("POST", `/projects/${project.body.id}/conversations`, {
          model: { provider: "claude-code-cli", id: "missing" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", `/projects/${project.body.id}/conversations`, {
          model: { provider: "claude-code-cli", id: "sonnet" },
          nativeReasoningLevel: "max",
        })
      ).status,
    ).toBe(400);
    const conversation = await call<{ id: string }>(
      "POST",
      `/projects/${project.body.id}/conversations`,
      {
        model: { provider: "claude-code-cli", id: "sonnet" },
        nativeReasoningLevel: "high",
      },
    );
    expect(conversation.status).toBe(201);
    const detail = await call<{ settings: unknown }>(
      "GET",
      `/projects/${project.body.id}/conversations/${conversation.body.id}`,
    );
    expect(detail.body.settings).toEqual({
      model: { provider: "claude-code-cli", id: "sonnet" },
      nativeReasoningLevel: "high",
    });
    const switched = await call(
      "PUT",
      `/projects/${project.body.id}/conversations/${conversation.body.id}/model`,
      { provider: "claude-code-cli", id: "haiku" },
    );
    expect(switched.body).toEqual({
      model: { provider: "claude-code-cli", id: "haiku" },
    });
    expect(
      (
        await call(
          "PUT",
          `/projects/${project.body.id}/conversations/${conversation.body.id}/reasoning`,
          { level: "high" },
        )
      ).status,
    ).toBe(400);

    // Turned off, the agent's models leave the picker and its conversations wait for it.
    await call("PATCH", "/agent-runtimes/claude-code-cli", { enabled: false });
    expect(
      (
        await call<AgentModelCatalog>("GET", "/models?runtimes=1")
      ).body.models.some((model) => isAgentRuntimeId(model.provider)),
    ).toBe(false);
    expect(
      (
        await call(
          "POST",
          `/projects/${project.body.id}/conversations/${conversation.body.id}/turns`,
          { prompt: "hi" },
        )
      ).status,
    ).toBe(409);
  });

  it.skipIf(process.platform === "win32")("lets a coding agent's model be the default for new conversations, without changing Pi's default", async () => {
    const { call, claude } = await start();
    await call("PATCH", "/agent-runtimes/claude-code-cli", {
      binaryPath: claude,
      enabled: true,
    });
    expect(
      (
        await call("PUT", "/models/default", {
          model: { provider: "claude-code-cli", id: "missing" },
          nativeReasoningLevel: "high",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", "/models/default", {
          model: { provider: "claude-code-cli", id: "sonnet" },
          nativeReasoningLevel: "max",
        })
      ).status,
    ).toBe(400);
    // Pi's reasoning enum is not a native effort; it is not coerced into one.
    expect(
      (
        await call("PUT", "/models/default", {
          model: { provider: "claude-code-cli", id: "sonnet" },
          reasoningLevel: "high",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", "/models/default", {
          model: { provider: "claude-code-cli", id: "sonnet" },
          nativeReasoningLevel: "high",
        })
      ).status,
    ).toBe(204);
    const catalog = await call<AgentModelCatalog>("GET", "/models?runtimes=1");
    expect(catalog.body).toMatchObject({
      defaultModel: { provider: "claude-code-cli", id: "sonnet" },
      defaultNativeReasoningLevel: "high",
    });
    // Canvas text and other one-off generation keep Pi's default.
    expect(
      (await call<AgentModelCatalog>("GET", "/models")).body.defaultModel,
    ).toBeUndefined();

    const project = await call<{ id: string }>("POST", "/projects", {
      name: "Game",
      type: "general",
    });
    const conversation = await call<{ id: string }>(
      "POST",
      `/projects/${project.body.id}/conversations`,
      {},
    );
    const detail = await call<{ settings: unknown }>(
      "GET",
      `/projects/${project.body.id}/conversations/${conversation.body.id}`,
    );
    expect(detail.body.settings).toEqual({
      model: { provider: "claude-code-cli", id: "sonnet" },
      nativeReasoningLevel: "high",
    });

    // Turned off, the agent no longer starts new conversations.
    await call("PATCH", "/agent-runtimes/claude-code-cli", { enabled: false });
    const later = await call<{ id: string }>(
      "POST",
      `/projects/${project.body.id}/conversations`,
      {},
    );
    expect(
      (
        await call<{ settings: unknown }>(
          "GET",
          `/projects/${project.body.id}/conversations/${later.body.id}`,
        )
      ).body.settings,
    ).toEqual({});
  });

  it("answers the tool bridge only with a session's own token, never the app's", async () => {
    const { app, call } = await start();
    const anonymous = await app.inject({
      method: "POST",
      url: "/agent-runtime-bridge/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(anonymous.statusCode).toBe(401);
    const withAppToken = await call("POST", "/agent-runtime-bridge/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(withAppToken.status).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/agent-runtime-bridge/mcp" }))
        .statusCode,
    ).toBe(405);
    // Everything else still needs the app's token.
    expect(
      (await app.inject({ method: "GET", url: "/agent-runtimes" })).statusCode,
    ).toBe(401);
  });

  it("refuses an answer to an approval request that is not waiting", async () => {
    const { call } = await start();
    const project = await call<{ id: string }>("POST", "/projects", {
      name: "Game",
      type: "general",
    });
    const conversation = await call<{ id: string }>(
      "POST",
      `/projects/${project.body.id}/conversations`,
      {},
    );
    expect(
      (
        await call(
          "POST",
          `/projects/${project.body.id}/conversations/${conversation.body.id}/approvals/nothing`,
          { decision: "allow" },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          "POST",
          `/projects/${project.body.id}/conversations/${conversation.body.id}/approvals/nothing`,
          { decision: "maybe" },
        )
      ).status,
    ).toBe(400);
  });
});
