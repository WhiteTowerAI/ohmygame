import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";
import { AgentRuntimeSettingsStore } from "../src/daemon/agent-runtimes/settings.js";
import { ensureOhMyGamePiEnvironment } from "../src/daemon/pi-agent.js";
import { createApp } from "../src/daemon/app.js";
import * as codexPool from "../src/daemon/agent-runtimes/codex-server-pool.js";
import * as environment from "../src/daemon/agent-runtimes/environment.js";
import {
  isAgentRuntimeId,
  type AgentRuntimeStatus,
  type AgentAccountProfile,
  type AgentAccountProfileStatus,
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

/** Codex's protocol stand-in reports the home used by every process, without exposing credentials. */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const home = process.env.CODEX_HOME || "system", account = path.basename(home);
const log = process.argv[1] + ".log";
const args = process.argv.slice(2);
const record = (extra) => fs.appendFileSync(log, JSON.stringify({pid:process.pid,home,args,...extra}) + "\\n");
record({});
if (args[0] === "--version") { console.log("codex-cli 0.163.0"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
let next = 0;
const send = (value) => console.log(JSON.stringify(value));
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  record({method:m.method,params:m.params});
  let result = {};
  if (m.method === "config/read") result = {config:{}};
  if (m.method === "thread/start" || m.method === "thread/resume") result = {thread:{id:m.params.threadId || account+"-thread-"+(++next)},activePermissionProfile:{id:m.params.permissions}};
  if (m.method === "model/list") result = {data:[{id:"gpt-test",displayName:"Codex "+account,supportedReasoningEfforts:[{reasoningEffort:"high"}]}]};
  if (m.method === "account/read") result = {account:{type:"chatgpt",email:account+"@example.com"}};
  if (m.method === "account/rateLimits/read") result = {rateLimits:{primary:{usedPercent:account === "personal" ? 13 : 47,windowDurationMins:300,resetsAt:2000000000}}};
  if (m.method === "account/login/start") result = {authUrl:"https://auth.openai.com/fixture/"+account,loginId:"test-login"};
  if (m.method === "turn/start") result = {turn:{id:"turn-"+(++next)}};
  send({id:m.id,result});
  if (m.method === "account/login/start") setTimeout(() => send({method:"account/login/completed",params:{loginId:"test-login",success:true}}),10);
  if (m.method === "turn/interrupt") send({method:"turn/completed",params:{threadId:m.params.threadId,turn:{id:m.params.turnId,status:"interrupted"}}});
  if (m.method === "turn/start" && !JSON.stringify(m.params.input).includes("hold busy")) {
    const threadId = m.params.threadId;
    send({method:"item/completed",params:{threadId,item:{id:"answer-"+next,type:"agentMessage",text:"Account reply",phase:"final_answer"}}});
    send({method:"turn/completed",params:{threadId,turn:{id:result.turn.id,status:"completed"}}});
  }
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
  // Match server.ts startup: built-in Skills exist before the first native session is keyed.
  await ensureOhMyGamePiEnvironment(path.join(dataDirectory, "pi-agent"));
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
  return { app, call, claude, dataDirectory };
}

describe("coding agent routes", () => {
  it.skipIf(process.platform === "win32")("isolates Codex account homes, login, catalogs, usage and shared servers", async () => {
    const identity = vi.spyOn(codexPool, "codexServerIdentity");
    const { call, dataDirectory } = await start();
    const codex = path.join(dataDirectory, "codex-fixture");
    await writeFile(codex, FAKE_CODEX, { mode: 0o700 });
    await call("PATCH", "/agent-runtimes/codex-cli", { binaryPath: codex, enabled: true });
    const add = async (name: string) => {
      const configDirectory = path.join(dataDirectory, name);
      await mkdir(configDirectory);
      await writeFile(path.join(configDirectory, "auth.json"), JSON.stringify({ fixture: "existing sign-in" }));
      return (await call<AgentAccountProfile>("POST", "/agent-runtimes/codex-cli/profiles", { name, configDirectory })).body;
    };
    const personal = await add("personal"), work = await add("work");
    for (const profile of [personal, work]) {
      const catalog = (await call<AgentModelCatalog>("GET", `/models?runtimes=1&profiles=${encodeURIComponent(JSON.stringify({ "codex-cli": profile.id }))}`)).body;
      expect(catalog.models.find((model) => model.provider === "codex-cli")?.name).toBe(`Codex ${profile.name}`);
      const login = await call<{url:string}>("POST", `/agent-runtimes/codex-cli/login?profileId=${profile.id}`);
      expect(login.body.url).toBe(`https://auth.openai.com/fixture/${profile.name}`);
      expect(JSON.parse(await readFile(path.join(profile.configDirectory!, "auth.json"), "utf8"))).toEqual({ fixture: "existing sign-in" });
    }
    const profiles = (await call<AgentAccountProfileStatus[]>("GET", "/agent-runtimes/codex-cli/profiles")).body;
    expect(profiles.find((profile) => profile.id === personal.id)).toMatchObject({auth:{account:"personal@example.com"},limits:[{usedPercent:13}]});
    expect(profiles.find((profile) => profile.id === work.id)).toMatchObject({auth:{account:"work@example.com"},limits:[{usedPercent:47}]});
    const project = (await call<ProjectState>("POST", "/projects", {})).body;
    const create = async (profileId: string) => {
      const chat = (await call<ConversationSummary>("POST", `/projects/${project.id}/conversations`, { model: { provider: "codex-cli", id: "gpt-test" } })).body;
      const base = `/projects/${project.id}/conversations/${chat.id}`;
      expect((await call("PUT", `${base}/account-profile`, {runtime:"codex-cli",profileId})).status).toBe(200);
      return base;
    };
    const first = await create(personal.id), second = await create(personal.id), third = await create(work.id);
    const turn = async (base: string, prompt = "Hello") => {
      expect((await call("POST", `${base}/turns`, {prompt})).status).toBe(202);
      await vi.waitFor(async () => expect((await call<ConversationDetail>("GET", base)).body.agent.status).toBe("idle"));
    };
    const log = async () => (await readFile(codex+".log", "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    await turn(first); await turn(second); await turn(third);
    let turns = (await log()).filter((entry) => entry.method === "turn/start");
    expect(turns).toHaveLength(3);
    const identityResults = await Promise.all(identity.mock.results.map((result) => result.value));
    expect(identityResults[0].key).toBe(identityResults[1].key);
    expect(identityResults[0].key).not.toBe(identityResults[2].key);
    expect(turns[0].pid).toBe(turns[1].pid);
    expect(turns[0].pid).not.toBe(turns[2].pid);
    expect(turns[0].params.threadId).not.toBe(turns[1].params.threadId);
    await call("PUT", `${first}/account-profile`, {runtime:"codex-cli",profileId:work.id});
    await turn(first, "Continue on work");
    await turn(second, "Still personal");
    turns = (await log()).filter((entry) => entry.method === "turn/start");
    expect(turns[3].pid).toBe(turns[2].pid);
    expect(turns[4].pid).toBe(turns[0].pid);
    expect(JSON.stringify(turns[3].params.input)).toContain("conversation-handoff");
    // Selecting an account for one chat leaves the original and the new-chat default alone.
    expect((await call<ConversationDetail>("GET", second)).body.settings.accountProfiles?.["codex-cli"]).toBe(personal.id);
    expect((await call("PUT", `${first}/account-profile`, {runtime:"opencode-cli",profileId:work.id})).status).toBe(400);
    expect((await call("GET", "/agent-runtimes/opencode-cli/profiles")).status).toBe(404);
    expect((await call("GET", "/models?runtimes=1&profiles=invalid")).status).toBe(400);
    // A warm account switch, model lookup and usage read must not re-probe or create a session.
    const beforeSwitch = await log();
    expect(beforeSwitch.some((entry) => entry.method === "account/logout")).toBe(false);
    const beforeIdentity = identity.mock.calls.length;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      for (const profile of [personal, work, personal, work]) {
        expect((await call("PUT", `${first}/account-profile`, {runtime:"codex-cli",profileId:profile.id})).status).toBe(200);
        expect((await call<{contextUsage:{limits:Array<{usedPercent:number}>}}>("GET", `${first}/context-usage`)).body.contextUsage.limits[0].usedPercent).toBe(profile.id === personal.id ? 13 : 47);
        const cached = await call<AgentModelCatalog>("GET", `/models?runtimes=1&profiles=${encodeURIComponent(JSON.stringify({"codex-cli":profile.id}))}`);
        expect(cached.body.models.find((model) => model.provider === "codex-cli")?.name).toBe(`Codex ${profile.name}`);
      }
      expect(await log()).toEqual(beforeSwitch);
      expect(identity).toHaveBeenCalledTimes(beforeIdentity);
    } finally { clock.mockRestore(); }
    expect(beforeSwitch.filter((entry) => entry.method === "account/read").every((entry) => entry.params.refreshToken === false)).toBe(true);
    await call("PATCH", "/agent-runtimes/codex-cli", {defaultProfileId:work.id});
    const newChat = (await call<ConversationSummary>("POST", `/projects/${project.id}/conversations`, {model:{provider:"codex-cli",id:"gpt-test"}})).body;
    expect((await call<ConversationDetail>("GET", `/projects/${project.id}/conversations/${newChat.id}`)).body.settings.accountProfiles?.["codex-cli"]).toBe(work.id);
    expect((await call<ConversationDetail>("GET", second)).body.settings.accountProfiles?.["codex-cli"]).toBe(personal.id);
    const independent = new AgentRuntimeService(dataDirectory, () => undefined);
    await independent.settings.load();
    expect((await independent.cli("codex-cli"))?.env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect((await independent.codexImageConnection())?.env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    const busy = await call<{turnId:string}>("POST", `${second}/turns`, {prompt:"hold busy"});
    await vi.waitFor(async () => expect((await call<ConversationDetail>("GET", second)).body.agent.status).toBe("running"));
    expect((await call("PUT", `${second}/account-profile`, {runtime:"codex-cli",profileId:work.id})).status).toBe(409);
    await call("POST", `${second}/turns/${busy.body.turnId}/cancel`);
    await vi.waitFor(async () => expect((await call<ConversationDetail>("GET", second)).body.agent.status).toBe("idle"));

  });

  it("creates private Codex homes before login and retains both runtimes' profile defaults after restart", async () => {
    const { call, dataDirectory } = await start();
    const codex = await call<AgentAccountProfile>("POST", "/agent-runtimes/codex-cli/profiles", { name: "Personal" });
    const claude = await call<AgentAccountProfile>("POST", "/agent-runtimes/claude-code-cli/profiles", { name: "Work" });
    expect(codex.status).toBe(201);
    expect(claude.status).toBe(201);
    expect(await readFile(path.join(codex.body.configDirectory!, "config.toml"), "utf8")).toBe('cli_auth_credentials_store = "file"\n');
    const settings = new AgentRuntimeSettingsStore(dataDirectory);
    await settings.load();
    expect(settings.profiles("claude-code-cli")).toContainEqual(claude.body);
    expect(settings.profiles("codex-cli")).toContainEqual(codex.body);
    await settings.update("claude-code-cli", { defaultProfileId: claude.body.id });
    await settings.update("codex-cli", { defaultProfileId: codex.body.id });
    const reopened = new AgentRuntimeSettingsStore(dataDirectory);
    await reopened.load();
    expect(reopened.get("claude-code-cli").defaultProfileId).toBe(claude.body.id);
    expect(reopened.get("codex-cli").defaultProfileId).toBe(codex.body.id);
  });

  it.skipIf(process.platform === "win32")("keeps profile authentication, catalog caches and chat selections separate", async () => {
    const source = FAKE_CLAUDE
      .replace('email: "player@example.com"', 'email: (process.env.CLAUDE_CONFIG_DIR ? require("node:path").basename(process.env.CLAUDE_CONFIG_DIR) : "system") + "@example.com"')
      .replace('displayName: "Sonnet"', 'displayName: "Sonnet " + (process.env.CLAUDE_CONFIG_DIR ? require("node:path").basename(process.env.CLAUDE_CONFIG_DIR) : "system")');
    const { call, claude, dataDirectory } = await start(source);
    await call("PATCH", "/agent-runtimes/claude-code-cli", { binaryPath: claude, enabled: true });
    const add = async (name: string) => { await mkdir(path.join(dataDirectory, name), { recursive: true }); return call<AgentAccountProfile>("POST", "/agent-runtimes/claude-code-cli/profiles", { name, configDirectory: path.join(dataDirectory, name) }); };
    const personal = (await add("personal")).body;
    const work = (await add("work")).body;
    const profiles = (await call<AgentAccountProfileStatus[]>("GET", "/agent-runtimes/claude-code-cli/profiles")).body;
    expect(profiles.find((profile) => profile.id === personal.id)?.auth.account).toBe("personal@example.com");
    expect(profiles.find((profile) => profile.id === work.id)?.auth.account).toBe("work@example.com");
    for (const profile of [personal, work]) {
      const models = (await call<AgentModelCatalog>("GET", `/models?runtimes=1&profiles=${encodeURIComponent(JSON.stringify({ "claude-code-cli": profile.id }))}`)).body;
      expect(models.models.find((model) => model.provider === "claude-code-cli" && model.id === "sonnet")?.name).toBe(`Sonnet ${profile.name}`);
    }
    await call("PATCH", "/agent-runtimes/claude-code-cli", { defaultProfileId: work.id });
    const project = (await call<ProjectState>("POST", "/projects", { name: "Profiles" })).body;
    const chat = (await call<ConversationSummary>("POST", `/projects/${project.id}/conversations`, { model: { provider: "claude-code-cli", id: "sonnet" } })).body;
    const base = `/projects/${project.id}/conversations/${chat.id}`;
    expect((await call<ConversationDetail>("GET", base)).body.settings.accountProfiles?.["claude-code-cli"]).toBe(work.id);
    expect((await call("PUT", `${base}/account-profile`, { runtime: "claude-code-cli", profileId: personal.id })).status).toBe(200);
    expect((await call<ConversationDetail>("GET", base)).body.settings.accountProfiles?.["claude-code-cli"]).toBe(personal.id);
    expect((await call("PUT", `${base}/account-profile`, { runtime: "claude-code-cli", profileId: "missing" })).status).toBe(400);
    expect((await call("POST", "/agent-runtimes/claude-code-cli/profiles", { name: "Relative", configDirectory: "relative" })).status).toBe(400);
    expect((await add("personal")).status).toBe(400);
    const settings = new AgentRuntimeSettingsStore(dataDirectory);
    await settings.load();
    expect(settings.profiles("claude-code-cli")).toContainEqual(work);
    expect(settings.get("claude-code-cli").defaultProfileId).toBe(work.id);
  });

  it.skipIf(process.platform === "win32")("passes a profile to login and inference and removes ambient OAuth overrides", async () => {
    const { call, claude, dataDirectory } = await start();
    const log = path.join(dataDirectory, "environment.jsonl");
    const source = FAKE_CLAUDE
      .replace('const args = process.argv.slice(2);', `const args = process.argv.slice(2); require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, dir: process.env.CLAUDE_CONFIG_DIR, tokenPresent: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)}) + "\\n"); if (args[0] === "auth" && args[1] === "login") process.exit(0);`)
      .replace('if (message.type !== "control_request") return;', `if (message.type === "user") { console.log(JSON.stringify({type:"system", subtype:"init", session_id:"test-thread"})); console.log(JSON.stringify({type:"assistant", message:{content:[{type:"text",text:"Profile answer"}]}})); console.log(JSON.stringify({type:"result",subtype:"success"})); return; } if (message.type !== "control_request") return;`);
    await writeFile(claude, source);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fixture-ambient-token");
    try {
      await call("PATCH", "/agent-runtimes/claude-code-cli", { binaryPath: claude, enabled: true });
      const profile = (await call<AgentAccountProfile>("POST", "/agent-runtimes/claude-code-cli/profiles", { name: "Work" })).body;
      const login = await call<{command: string}>("POST", `/agent-runtimes/claude-code-cli/login?profileId=${profile.id}`);
      expect(login.body.command).toContain(profile.configDirectory);
      const project = (await call<ProjectState>("POST", "/projects", {})).body;
      const chat = (await call<ConversationSummary>("POST", `/projects/${project.id}/conversations`, { model: { provider: "claude-code-cli", id: "sonnet" } })).body;
      const base = `/projects/${project.id}/conversations/${chat.id}`;
      await call("PUT", `${base}/account-profile`, { runtime: "claude-code-cli", profileId: profile.id });
      expect((await call("POST", `${base}/turns`, { prompt: "Hello" })).status).toBe(202);
      await vi.waitFor(async () => expect((await call<ConversationDetail>("GET", base)).body.agent.status).toBe("idle"));
      const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const selected = records.filter((record) => record.dir === profile.configDirectory);
      expect(selected.some((record) => record.args[0] === "auth" && record.args[1] === "login")).toBe(true);
      expect(selected.some((record) => record.args[0] === "-p")).toBe(true);
      expect(selected.every((record) => !record.tokenPresent)).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });

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
