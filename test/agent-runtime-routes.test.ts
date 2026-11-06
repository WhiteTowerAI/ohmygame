import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { ConversationManager } from "../src/daemon/conversations.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";
import { AgentRuntimeSettingsStore } from "../src/daemon/agent-runtimes/settings.js";
import { ensureOhMyGamePiEnvironment } from "../src/daemon/pi-agent.js";
import { createApp } from "../src/daemon/app.js";
import * as codexPool from "../src/daemon/agent-runtimes/codex-server-pool.js";
import * as environment from "../src/daemon/agent-runtimes/environment.js";
import * as discovery from "../src/daemon/agent-runtimes/discovery.js";
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
if (args[0] === "logout") { console.log("Successfully logged out"); process.exit(0); }
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
  if (m.method === "turn/start" && !m.params.input.some(item => item.type === "text" && item.text.trim() === "hold busy")) {
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

/** An agent that speaks the Agent Client Protocol with `--acp`, as a plugin declares it. */
const FAKE_ACP = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("fake-acp 1.2.3"); process.exit(0); }
if (args[0] !== "--acp") process.exit(2);
const send = (value) => console.log(JSON.stringify(value));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined || !m.method) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } });
  if (m.method === "session/new") return reply({ sessionId: "fake-session", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "fake-model", options: [{ value: "fake-model", name: "Fake model" }] }] });
  if (m.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ACP reply" } } } });
    return reply({ stopReason: "end_turn" });
  }
  reply({});
});
`;

describe("coding agent routes", () => {
  it.skipIf(process.platform === "win32")("adds a plugin's ACP agent to Agents, runs a conversation with it and follows the plugin", async () => {
    const { app, call, dataDirectory } = await start();
    // The agent reaches OhMyGame's tools over loopback, so the daemon listens.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const source = path.join(dataDirectory, "acp-plugin");
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({
      id: "acme/fake-acp", version: "1.0.0", engines: { "ohmygame-api": "^2.3.0" }, displayName: "Fake ACP", description: "An ACP agent",
      capabilities: { processes: ["fake-acp"] },
      contributes: { agents: [{ id: "fake", title: "Fake ACP", command: "fake-acp", args: ["--acp", "--note=a b"], loginCommand: "fake-acp login" }] },
    }));
    const payload = { source: { type: "directory", path: source } };
    const inspected = await call<{ digest: string }>("POST", "/plugin-sources/inspect", payload);
    expect(inspected.status).toBe(200);
    expect((await call("POST", "/plugin-sources/install", { ...payload, digest: inspected.body.digest })).status).toBe(201);
    const id = "agent.acme.fake-acp.fake";
    await vi.waitFor(async () =>
      expect((await call<AgentRuntimeStatus[]>("GET", "/agent-runtimes")).body.find((agent) => agent.id === id)).toMatchObject({
        name: "Fake ACP", plugin: "acme/fake-acp", launch: 'fake-acp --acp "--note=a b"', enabled: false, permissionMode: "allow",
      }),
    );
    const executable = path.join(dataDirectory, "fake-acp");
    await writeFile(executable, FAKE_ACP, { mode: 0o700 });
    expect((await call("PATCH", `/agent-runtimes/${id}`, { permissionMode: ":workspace" })).status).toBe(400);
    const status = await call<AgentRuntimeStatus>("PATCH", `/agent-runtimes/${id}`, { binaryPath: executable, enabled: true, permissionMode: "default" });
    expect(status.body).toMatchObject({ installed: true, version: "1.2.3", enabled: true, permissionMode: "default", diagnostics: [], launch: `${executable} --acp "--note=a b"` });
    const catalog = (await call<AgentModelCatalog>("GET", "/models?runtimes=1")).body;
    expect(catalog.models.find((model) => model.provider === id)).toMatchObject({ id: "fake-model", name: "Fake model", providerName: "Fake ACP" });
    expect((await call("POST", `/agent-runtimes/${id}/login`)).body).toEqual({ command: "fake-acp login" });

    const project = (await call<ProjectState>("POST", "/projects", {})).body;
    const chat = (await call<ConversationSummary>("POST", `/projects/${project.id}/conversations`, { model: { provider: id, id: "fake-model" } })).body;
    const base = `/projects/${project.id}/conversations/${chat.id}`;
    expect(await call("POST", `${base}/turns`, { prompt: "Hello" })).toMatchObject({ status: 202 });
    await vi.waitFor(async () => expect(JSON.stringify((await call<ConversationDetail>("GET", base)).body)).toContain("ACP reply"), { timeout: 10_000 });

    expect((await call("PUT", "/plugin-store/acme/fake-acp/enabled", { enabled: false })).status).toBe(204);
    await vi.waitFor(async () =>
      expect((await call<AgentRuntimeStatus[]>("GET", "/agent-runtimes")).body.some((agent) => agent.id === id)).toBe(false),
    );
    expect((await call("POST", `/agent-runtimes/${id}/recheck`)).status).toBe(404);
  });

  it("accepts only the agent's own permission modes", async () => {
    const { call } = await start();
    expect(
      (await call("PATCH", "/agent-runtimes/codex-cli", { permissionMode: ":workspace" })).body,
    ).toMatchObject({ permissionMode: ":workspace" });
    // Claude Code's mode is not one of Codex's, and OhMyGame's former names are gone.
    for (const permissionMode of ["acceptEdits", "standard"])
      expect(
        (await call("PATCH", "/agent-runtimes/codex-cli", { permissionMode })).status,
      ).toBe(400);
  });

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
      expect(await call("POST", `${base}/turns`, {prompt})).toMatchObject({ status: 202 });
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
    // Choosing the account a chat already uses keeps its native thread.
    expect((await call("PUT", `${second}/account-profile`, {runtime:"codex-cli",profileId:personal.id})).status).toBe(200);
    await turn(second, "Same account");
    const sameAccount = (await log()).filter((entry) => entry.method === "turn/start");
    expect(sameAccount.at(-1).params.threadId).toBe(sameAccount.at(-2).params.threadId);
    expect(JSON.stringify(sameAccount.at(-1).params.input)).not.toContain("conversation-handoff");
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
    // Switching away and back with no turn on the other account resumes the same native thread.
    await turn(first, "Back on work");
    const back = (await log()).filter((entry) => entry.method === "turn/start").at(-1);
    expect(back.params.threadId).toBe(turns[3].params.threadId);
    expect(JSON.stringify(back.params.input)).not.toContain("conversation-handoff");
    expect(beforeSwitch.filter((entry) => entry.method === "account/read").every((entry) => entry.params.refreshToken === false)).toBe(true);
    await call("PATCH", "/agent-runtimes/codex-cli", {defaultProfileId:work.id});
    const newChat = (await call<ConversationSummary>("POST", `/projects/${project.id}/conversations`, {model:{provider:"codex-cli",id:"gpt-test"}})).body;
    expect((await call<ConversationDetail>("GET", `/projects/${project.id}/conversations/${newChat.id}`)).body.settings.accountProfiles?.["codex-cli"]).toBe(work.id);
    expect((await call<ConversationDetail>("GET", second)).body.settings.accountProfiles?.["codex-cli"]).toBe(personal.id);
    const independent = new AgentRuntimeService(dataDirectory, () => undefined);
    await independent.settings.load();
    // System default is the CLI's default home, whatever CODEX_HOME OhMyGame was launched with.
    vi.stubEnv("CODEX_HOME", path.join(dataDirectory, "inherited-codex"));
    try {
      expect((await independent.cli("codex-cli"))?.env.CODEX_HOME).toBeUndefined();
      expect((await independent.codexImageConnection())?.env.CODEX_HOME).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
    const busy = await call<{turnId:string}>("POST", `${second}/turns`, {prompt:"hold busy"});
    await vi.waitFor(async () => expect((await call<ConversationDetail>("GET", second)).body.agent.status).toBe("running"));
    expect((await call("PUT", `${second}/account-profile`, {runtime:"codex-cli",profileId:work.id})).status).toBe(409);
    await call("POST", `${second}/turns/${busy.body.turnId}/cancel`);
    await vi.waitFor(async () => expect((await call<ConversationDetail>("GET", second)).body.agent.status).toBe("idle"));

  });

  it.skipIf(process.platform === "win32")("pins default-account discovery while a different default is being saved", async () => {
    const { dataDirectory } = await start();
    const codex = path.join(dataDirectory, "codex-default-fixture");
    await writeFile(codex, FAKE_CODEX, { mode: 0o700 });
    const service = new AgentRuntimeService(dataDirectory, () => undefined);
    await service.settings.load();
    const personalDir = path.join(dataDirectory, "personal"), workDir = path.join(dataDirectory, "work");
    await mkdir(personalDir); await mkdir(workDir);
    const personal = await service.addAccountProfile("codex-cli", "Personal", personalDir);
    const work = await service.addAccountProfile("codex-cli", "Work", workDir);
    await service.settings.update("codex-cli", { enabled: true, binaryPath: codex, defaultProfileId: personal.id });
    const models = service.models(), status = service.status("codex-cli");
    await service.settings.update("codex-cli", { defaultProfileId: work.id });
    expect((await models).models.find((model) => model.provider === "codex-cli")?.name).toBe("Codex personal");
    expect((await status).auth.account).toBe("personal@example.com");
    expect((await service.models()).models.find((model) => model.provider === "codex-cli")?.name).toBe("Codex work");
  });

  it.skipIf(process.platform === "win32")("stops an unfinished sign-in before deleting its managed home", async () => {
    const { call, dataDirectory } = await start();
    const codex = path.join(dataDirectory, "codex-login-fixture");
    await writeFile(codex, FAKE_CODEX.replace('if (m.method === "account/login/start") setTimeout', 'if (false) setTimeout'), { mode: 0o700 });
    await call("PATCH", "/agent-runtimes/codex-cli", { binaryPath: codex });
    const profile = (await call<AgentAccountProfile>("POST", "/agent-runtimes/codex-cli/profiles", { name: "Signing in" })).body;
    expect((await call("POST", `/agent-runtimes/codex-cli/login?profileId=${profile.id}`)).status).toBe(200);
    const records = (await readFile(`${codex}.log`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const pid = records.find((record) => record.method === "account/login/start").pid;
    expect((await call("DELETE", `/agent-runtimes/codex-cli/profiles/${profile.id}`)).status).toBe(204);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await stat(profile.configDirectory!).catch(() => undefined)).toBeUndefined();
    const after = (await readFile(`${codex}.log`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(after.filter((record) => record.args[0] === "logout").map((record) => record.home)).toEqual([profile.configDirectory]);
  });

  it.each(["claude-code-cli", "codex-cli"] as const)("deletes managed %s files, preserves imports and resets defaults", async (runtime) => {
    const { call, dataDirectory } = await start();
    await call("PATCH", `/agent-runtimes/${runtime}`, { binaryPath: path.join(dataDirectory, "missing-cli") });
    const managed = (await call<AgentAccountProfile>("POST", `/agent-runtimes/${runtime}/profiles`, { name: "Managed" })).body;
    expect(managed.managed).toBe(true);
    await writeFile(path.join(managed.configDirectory!, "auth.json"), "managed credentials");
    await call("PATCH", `/agent-runtimes/${runtime}`, { defaultProfileId: managed.id });
    expect((await call("POST", `/agent-runtimes/${runtime}/profiles`, { name: "Alias", configDirectory: managed.configDirectory })).status).toBe(400);
    const home = path.join(dataDirectory, "home");
    const systemDirectory = path.join(home, runtime === "claude-code-cli" ? ".claude" : ".codex");
    const inheritedDirectory = path.join(dataDirectory, "inherited-cli");
    await mkdir(systemDirectory, { recursive: true });
    await mkdir(inheritedDirectory);
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.stubEnv(runtime === "claude-code-cli" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME", inheritedDirectory);
    try {
      expect((await call("POST", `/agent-runtimes/${runtime}/profiles`, { name: "System", configDirectory: systemDirectory })).status).toBe(400);
      // The folder OhMyGame was launched with is an ordinary account, not System default.
      const inherited = (await call<AgentAccountProfile>("POST", `/agent-runtimes/${runtime}/profiles`, { name: "Inherited", configDirectory: inheritedDirectory })).body;
      expect(inherited.managed).toBe(false);
      expect((await call("DELETE", `/agent-runtimes/${runtime}/profiles/${inherited.id}`)).status).toBe(204);
    } finally { vi.unstubAllEnvs(); homedir.mockRestore(); }
    expect((await call("DELETE", `/agent-runtimes/${runtime}/profiles/system`)).status).toBe(400);
    expect((await call("DELETE", `/agent-runtimes/${runtime}/profiles/missing`)).status).toBe(404);
    expect((await call("DELETE", `/agent-runtimes/opencode-cli/profiles/${managed.id}`)).status).toBe(404);
    expect((await call("DELETE", `/agent-runtimes/${runtime}/profiles/${managed.id}`)).status).toBe(204);
    expect(await stat(managed.configDirectory!).catch(() => undefined)).toBeUndefined();
    const importedDirectory = path.join(dataDirectory, "imported");
    await mkdir(importedDirectory);
    await writeFile(path.join(importedDirectory, "auth.json"), "existing credentials");
    await writeFile(`${importedDirectory}.json`, "existing CLI state");
    const imported = (await call<AgentAccountProfile>("POST", `/agent-runtimes/${runtime}/profiles`, { name: "Imported", configDirectory: importedDirectory })).body;
    expect(imported.managed).toBe(false);
    expect((await call("DELETE", `/agent-runtimes/${runtime}/profiles/${imported.id}`)).status).toBe(204);
    expect(await readFile(path.join(importedDirectory, "auth.json"), "utf8")).toBe("existing credentials");
    expect(await readFile(`${importedDirectory}.json`, "utf8")).toBe("existing CLI state");
    const reopened = new AgentRuntimeSettingsStore(dataDirectory);
    await reopened.load();
    expect(reopened.get(runtime).defaultProfileId).toBe("system");
    expect(reopened.profiles(runtime)).toEqual([{ id: "system", name: "System default" }]);
  });

  it("renames, reorders and repoints accounts while their ids and managed directories stay", async () => {
    const { call, dataDirectory } = await start();
    const runtime = "codex-cli";
    await call("PATCH", `/agent-runtimes/${runtime}`, { binaryPath: path.join(dataDirectory, "missing-cli") });
    const first = path.join(dataDirectory, "first-home");
    const moved = path.join(dataDirectory, "moved-home");
    await mkdir(first);
    await mkdir(moved);
    await writeFile(path.join(first, "auth.json"), "kept");
    const imported = (await call<AgentAccountProfile>("POST", `/agent-runtimes/${runtime}/profiles`, { name: "Imported", configDirectory: first })).body;
    const managed = (await call<AgentAccountProfile>("POST", `/agent-runtimes/${runtime}/profiles`, { name: "Managed" })).body;
    const url = (id: string) => `/agent-runtimes/${runtime}/profiles/${id}`;

    expect((await call<AgentAccountProfile>("PATCH", url(managed.id), { name: " Studio " })).body).toMatchObject({ id: managed.id, name: "Studio", configDirectory: managed.configDirectory, managed: true });
    expect((await call("PATCH", url(managed.id), { configDirectory: moved })).status).toBe(400);
    expect((await call("PATCH", url("system"), { name: "Mine" })).status).toBe(400);
    expect((await call("PATCH", url("missing"), { name: "Mine" })).status).toBe(404);
    expect((await call("PATCH", url(imported.id), {})).status).toBe(400);
    expect((await call("PATCH", url(imported.id), { configDirectory: managed.configDirectory })).status).toBe(400);

    const taken = path.join(dataDirectory, "taken-home");
    await mkdir(taken);
    const other = (await call<AgentAccountProfile>("POST", `/agent-runtimes/${runtime}/profiles`, { name: "Other", configDirectory: taken })).body;
    expect((await call("PATCH", url(imported.id), { configDirectory: taken })).status).toBe(400);
    expect((await call("DELETE", url(other.id))).status).toBe(204);

    const repointed = (await call<AgentAccountProfile>("PATCH", url(imported.id), { configDirectory: moved })).body;
    expect(repointed).toMatchObject({ id: imported.id, name: "Imported", managed: false });
    expect(repointed.configDirectory).toBe(await realpath(moved));
    expect(await readFile(path.join(first, "auth.json"), "utf8")).toBe("kept");
    const directory = await call<{ path: string }>("GET", `${url(imported.id)}/directory`);
    expect(directory.body.path).toBe(repointed.configDirectory);

    expect((await call("POST", `${url("system")}/move`, { direction: 1 })).status).toBe(400);
    expect((await call("POST", `${url(imported.id)}/move`, { direction: 2 })).status).toBe(400);
    expect((await call("POST", `${url(imported.id)}/move`, { direction: 1 })).status).toBe(204);
    // The end of the list holds it there.
    expect((await call("POST", `${url(imported.id)}/move`, { direction: 1 })).status).toBe(204);
    const listed = (await call<AgentAccountProfileStatus[]>("GET", `/agent-runtimes/${runtime}/profiles`)).body;
    expect(listed.map((profile) => profile.id)).toEqual(["system", managed.id, imported.id]);
    expect(listed[0]!.directory).toMatch(/\.codex$/);
    const reopened = new AgentRuntimeSettingsStore(dataDirectory);
    await reopened.load();
    expect(reopened.profiles(runtime).map((profile) => profile.name)).toEqual(["System default", "Studio", "Imported"]);
  });

  it.skipIf(process.platform === "win32")("refuses deletion of a running account and falls back without resuming its native context", async () => {
    const { call, dataDirectory } = await start();
    const codex = path.join(dataDirectory, "codex-delete-fixture");
    await writeFile(codex, FAKE_CODEX, { mode: 0o700 });
    await call("PATCH", "/agent-runtimes/codex-cli", { binaryPath: codex, enabled: true });
    const profile = (await call<AgentAccountProfile>("POST", "/agent-runtimes/codex-cli/profiles", { name: "Work" })).body;
    await call("PATCH", "/agent-runtimes/codex-cli", { defaultProfileId: profile.id });
    const project = (await call<ProjectState>("POST", "/projects", {})).body;
    const create = async () => {
      const chat = (await call<ConversationSummary>("POST", `/projects/${project.id}/conversations`, { model: { provider: "codex-cli", id: "gpt-test" } })).body;
      return `/projects/${project.id}/conversations/${chat.id}`;
    };
    const base = await create(), untouched = await create();
    const turn = (prompt: string) => call<{ turnId: string }>("POST", `${base}/turns`, { prompt });
    const wait = () => vi.waitFor(async () => expect((await call<ConversationDetail>("GET", base)).body.agent.status).toBe("idle"));
    expect((await turn("Hello")).status).toBe(202);
    await wait();
    const running = await turn("hold busy");
    // Status is set before the CLI receives its turn; wait at the protocol boundary too.
    await vi.waitFor(async () => expect(await readFile(`${codex}.log`, "utf8")).toContain("hold busy"));
    const removal = `/agent-runtimes/codex-cli/profiles/${profile.id}`;
    expect((await call("DELETE", removal)).status).toBe(409);
    expect((await stat(profile.configDirectory!)).isDirectory()).toBe(true);
    expect((await call<ConversationDetail>("GET", base)).body.settings.accountProfiles?.["codex-cli"]).toBe(profile.id);
    // Work on this account must not block removal of a different account.
    const idle = (await call<AgentAccountProfile>("POST", "/agent-runtimes/codex-cli/profiles", { name: "Unused" })).body;
    expect((await call("DELETE", `/agent-runtimes/codex-cli/profiles/${idle.id}`)).status).toBe(204);
    await call("POST", `${base}/turns/${running.body.turnId}/cancel`);
    await wait();
    expect((await call("DELETE", removal)).status).toBe(204);
    for (const chat of [base, untouched]) {
      expect((await call<ConversationDetail>("GET", chat)).body.settings.accountProfiles).toBeUndefined();
      expect((await call("GET", `${chat}/context-usage`)).status).toBe(200);
    }
    const staleCatalog = await call<AgentModelCatalog>("GET", `/models?runtimes=1&profiles=${encodeURIComponent(JSON.stringify({ "codex-cli": profile.id }))}`);
    expect(staleCatalog.status).toBe(200);
    expect(staleCatalog.body.models.find((model) => model.provider === "codex-cli")).toBeDefined();
    expect((await call("PUT", `${base}/account-profile`, { runtime: "codex-cli", profileId: profile.id })).status).toBe(400);
    expect((await turn("Continue after deletion")).status).toBe(202);
    await wait();
    const records = (await readFile(`${codex}.log`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const lastTurn = records.filter((record) => record.method === "turn/start").at(-1);
    expect(lastTurn.home).not.toBe(profile.configDirectory);
    expect(JSON.stringify(lastTurn.params.input)).toContain("conversation-handoff");
    expect(records.filter((record) => record.home === lastTurn.home && record.method === "thread/resume")).toHaveLength(0);
    expect(await stat(profile.configDirectory!).catch(() => undefined)).toBeUndefined();
    expect(await readFile(path.join(dataDirectory, "agent-runtimes", "limits.json"), "utf8")).not.toContain(profile.id);
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
      .replace('{ value: "haiku", displayName: "Haiku" }] }', '{ value: "haiku", displayName: "Haiku" }].filter((model) => model.value === "haiku" || !String(process.env.CLAUDE_CONFIG_DIR).endsWith("limited")) }')
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
    expect((await call("PUT", `${base}/account-profile`, { runtime: "claude-code-cli", profileId: personal.id })).body).toEqual({ runtime: "claude-code-cli", profileId: personal.id });
    expect((await call("PUT", `${base}/account-profile`, { runtime: "claude-code-cli", profileId: "missing" })).status).toBe(400);
    const limited = (await add("limited")).body;
    expect((await call("PUT", `${base}/account-profile`, { runtime: "claude-code-cli", profileId: limited.id })).body).toMatchObject({ profileId: limited.id, model: { provider: "claude-code-cli", id: "haiku" } });
    expect((await call<ConversationDetail>("GET", base)).body.settings.model).toEqual({ provider: "claude-code-cli", id: "haiku" });
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
      .replace('const args = process.argv.slice(2);', `const args = process.argv.slice(2); require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, dir: process.env.CLAUDE_CONFIG_DIR, tokenPresent: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)}) + "\\n"); if (args[0] === "auth" && (args[1] === "login" || args[1] === "logout")) process.exit(0);`)
      .replace('if (message.type !== "control_request") return;', `if (message.type === "user") { console.log(JSON.stringify({type:"system", subtype:"init", session_id:"test-thread"})); console.log(JSON.stringify({type:"assistant", message:{content:[{type:"text",text:"Profile answer"}]}})); console.log(JSON.stringify({type:"result",subtype:"success"})); return; } if (message.type !== "control_request") return;`);
    await writeFile(claude, source);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fixture-ambient-token");
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dataDirectory, "inherited-claude"));
    try {
      await call("PATCH", "/agent-runtimes/claude-code-cli", { binaryPath: claude, enabled: true });
      // System default signs in to the default folder, not the one OhMyGame was launched with.
      // The command shown for a terminal clears the variable, which that terminal may set even when OhMyGame has none.
      for (const inherited of [path.join(dataDirectory, "inherited-claude"), undefined]) {
        vi.stubEnv("CLAUDE_CONFIG_DIR", inherited);
        expect((await call<{command: string}>("POST", "/agent-runtimes/claude-code-cli/login")).body.command).toBe(`env -u CLAUDE_CONFIG_DIR '${claude}' auth login`);
      }
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dataDirectory, "inherited-claude"));
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
      expect(records.some((record) => record.args[0] === "auth" && record.args[1] === "login" && record.dir === undefined)).toBe(true);
      expect(records.some((record) => String(record.dir).includes("inherited-claude"))).toBe(false);
      const selected = records.filter((record) => record.dir === profile.configDirectory);
      expect(selected.some((record) => record.args[0] === "auth" && record.args[1] === "login")).toBe(true);
      expect(selected.some((record) => record.args[0] === "-p")).toBe(true);
      expect(selected.every((record) => !record.tokenPresent)).toBe(true);
      const importedDirectory = path.join(dataDirectory, "imported");
      await mkdir(importedDirectory);
      const imported = (await call<AgentAccountProfile>("POST", "/agent-runtimes/claude-code-cli/profiles", { name: "Imported", configDirectory: importedDirectory })).body;
      for (const removed of [profile, imported]) expect((await call("DELETE", `/agent-runtimes/claude-code-cli/profiles/${removed.id}`)).status).toBe(204);
      const logouts = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((record) => record.args[0] === "auth" && record.args[1] === "logout");
      expect(logouts).toEqual([{ args: ["auth", "logout"], dir: profile.configDirectory, tokenPresent: false }]);
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "win32").each(["codex.cmd", "codex.ps1"])(
    "resolves a manually selected %s through the settings API without running the shim",
    async (name) => {
      const { call, dataDirectory } = await start();
      const prefix = path.join(dataDirectory, "npm prefix with spaces");
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const target = arch === "arm64" ? "aarch64" : "x86_64";
      const native = path.join(
        prefix,
        "node_modules",
        "@openai",
        `codex-win32-${arch}`,
        "vendor",
        `${target}-pc-windows-msvc`,
        "bin",
        "codex.exe",
      );
      await mkdir(path.dirname(native), { recursive: true });
      await writeFile(native, "Native fixture; probes are simulated");
      const shim = path.join(prefix, name);
      await writeFile(shim, "This shell shim must never run");
      const version = vi
        .spyOn(discovery, "probeVersion")
        .mockResolvedValue("0.164.0");
      const auth = vi
        .spyOn(discovery, "probeAuth")
        .mockResolvedValue({ status: "signed-in", billing: "subscription" });
      const response = await call<AgentRuntimeStatus>(
        "PATCH",
        "/agent-runtimes/codex-cli",
        { binaryPath: shim },
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        configuredBinaryPath: shim,
        binaryPath: native,
        binarySource: "manual",
        installed: true,
        diagnostics: [],
      });
      expect(version).toHaveBeenCalledWith(
        native,
        "codex-cli",
        expect.any(Object),
      );
      expect(auth).toHaveBeenCalledWith(
        native,
        "codex-cli",
        expect.any(Object),
      );
      version.mockClear();
      auth.mockClear();
      await rm(native);
      const missing = await call<AgentRuntimeStatus>(
        "PATCH",
        "/agent-runtimes/codex-cli",
        { binaryPath: shim },
      );
      expect(missing.status).toBe(200);
      expect(missing.body).toMatchObject({
        configuredBinaryPath: shim,
        installed: false,
        diagnostics: [expect.objectContaining({ code: "invalid-executable" })],
      });
      expect(version).not.toHaveBeenCalled();
      expect(auth).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["codex-cli", "unsupported.cmd"],
    ["codex-cli", "unsupported.ps1"],
    ["codex-cli", "codex.bat"],
    ["claude-code-cli", "codex.cmd"],
    ["claude-code-cli", "codex.ps1"],
  ])(
    "rejects unsupported scripts for %s: %s before saving settings",
    async (runtime, name) => {
      const { call, dataDirectory } = await start();
      const script = path.join(dataDirectory, name);
      await writeFile(script, "This script must never run");
      const before = await call<AgentRuntimeStatus>(
        "PATCH",
        `/agent-runtimes/${runtime}`,
        {
          binaryPath: path.join(dataDirectory, "missing-cli"),
        },
      );
      const response = await call("PATCH", `/agent-runtimes/${runtime}`, {
        binaryPath: script,
      });
      expect(response.status).toBe(400);
      const after = await call<AgentRuntimeStatus>(
        "PATCH",
        `/agent-runtimes/${runtime}`,
        { enabled: false },
      );
      expect(after.body.configuredBinaryPath).toBe(
        before.body.configuredBinaryPath,
      );
      expect(
        await discovery.resolveBinary(
          runtime as "codex-cli" | "claude-code-cli",
          script,
        ),
      ).toBeUndefined();
    },
  );

  it.skipIf(process.platform === "win32")("persists the start step and completes setup using only a CLI", async () => {
    const { call, claude } = await start();
    expect((await call("PUT", "/settings/onboarding", { status: "pending", step: "start" })).status).toBe(200);
    expect((await call<{ step: string }>("GET", "/settings/onboarding")).body.step).toBe("start");
    expect((await call("PUT", "/settings/onboarding", { status: "completed", step: "start" })).status).toBe(409);
    await call("PATCH", "/agent-runtimes/claude-code-cli", { binaryPath: claude, enabled: true });
    await call("PUT", "/models/default", { model: { provider: "claude-code-cli", id: "sonnet" }, nativeReasoningLevel: "high" });
    expect((await call("PUT", "/settings/onboarding", { status: "completed", step: "start" })).status).toBe(200);
    await call("PATCH", "/agent-runtimes/claude-code-cli", { enabled: false });
    expect((await call("PUT", "/settings/onboarding", { status: "completed", step: "start" })).status).toBe(409);
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
  it.skipIf(process.platform === "win32")("continues a conversation stopped at a usage limit once it resets, and follows the agent's setting", async () => {
    const { call, claude } = await start(FAKE_CLAUDE.replace(
      'if (message.type !== "control_request") return;',
      `if (message.type === "user") {
    const log = process.argv[1] + ".log", fs = require("node:fs");
    fs.appendFileSync(log, JSON.stringify(message.message.content) + "\\n");
    const limited = fs.readFileSync(log, "utf8").includes("Hit the limit") && !fs.readFileSync(log, "utf8").includes("Continue where you left off");
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    if (limited) {
      send({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 2 } });
      send({ type: "result", subtype: "success", is_error: true, result: "You've hit your 5-hour limit · resets 2:30am (Asia/Shanghai)" });
    } else send({ type: "result", subtype: "success" });
    return;
  }
  if (message.type !== "control_request") return;`,
    ));
    await call("PATCH", "/agent-runtimes/claude-code-cli", { binaryPath: claude, enabled: true });
    const project = (await call<ProjectState>("POST", "/projects", { name: "Limit", preset: "blank" })).body;
    const create = async () => `/projects/${project.id}/conversations/${(await call<ConversationSummary>("POST", `/projects/${project.id}/conversations`, { model: { provider: "claude-code-cli", id: "sonnet" } })).body.id}`;
    const stopped = async (base: string) => {
      expect(await call("POST", `${base}/turns`, { prompt: "Hit the limit" })).toMatchObject({ status: 202 });
      await vi.waitFor(async () => expect((await call<ConversationDetail>("GET", base)).body.agent.status).toBe("error"));
    };
    const usage = async (base: string) => (await call<{ contextUsage?: { limitResume?: { state: string } } }>("GET", `${base}/context-usage?passive=1`)).body.contextUsage?.limitResume;
    const sent = async () => (await readFile(`${claude}.log`, "utf8")).split("Continue where you left off").length - 1;

    // Only the wait for the margin after the reset is cut short.
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay?: number) => realTimeout(run, delay !== undefined && delay > 30_000 && delay <= 32_000 ? 1_000 : delay)) as typeof setTimeout);

    const off = await create();
    await stopped(off);
    await expect(usage(off)).resolves.toMatchObject({ state: "armed" });
    const turnedOff = await call<AgentRuntimeStatus>("PATCH", "/agent-runtimes/claude-code-cli", { autoContinue: false });
    expect(turnedOff.body.autoContinue).toBe(false);
    await expect(usage(off)).resolves.toMatchObject({ state: "off" });
    await new Promise((resolve) => realTimeout(resolve, 1_500));
    expect(await sent()).toBe(0);
    await expect(usage(off)).resolves.toBeUndefined();
    await call("PATCH", "/agent-runtimes/claude-code-cli", { autoContinue: true });

    const skipped = await create();
    await stopped(skipped);
    expect((await call("POST", `${skipped}/limit-resume/skip`)).status).toBe(204);
    await expect(usage(skipped)).resolves.toMatchObject({ state: "skipped" });
    await new Promise((resolve) => realTimeout(resolve, 1_500));
    expect(await sent()).toBe(0);

    // Nothing reads this conversation between its failure and the continue.
    const armed = await create();
    await stopped(armed);
    await vi.waitFor(async () => expect(await sent()).toBe(1), { timeout: 5_000 });
    await vi.waitFor(async () => expect((await call<ConversationDetail>("GET", armed)).body.agent.status).toBe("idle"));
    expect(JSON.stringify((await call<ConversationDetail>("GET", armed)).body.turns)).toContain("Continue where you left off.");
    await expect(usage(armed)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("sends a scheduled message when it is due and the conversation is free, with nobody reading it", async () => {
    const { app, call, claude, dataDirectory } = await start(FAKE_CLAUDE.replace(
      'if (message.type !== "control_request") return;',
      `if (message.type === "user") {
    const fs = require("node:fs"), log = process.argv[1] + ".log", content = JSON.stringify(message.message.content);
    fs.appendFileSync(log, content + "\\n");
    const finish = () => {
      fs.appendFileSync(log, "finished\\n");
      process.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\\n");
    };
    if (content.includes("Take a while")) setTimeout(finish, 1_500);
    else finish();
    return;
  }
  if (message.type !== "control_request") return;`,
    ));
    // Only the wait between its looks is cut short: other timers of this length, like the agent's handshake, stay.
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay?: number) => realTimeout(run, delay === 30_000 && new Error().stack?.includes("scheduled-messages") ? 50 : delay)) as typeof setTimeout);
    const pause = (ms: number) => new Promise((resolve) => realTimeout(resolve, ms));

    await call("PATCH", "/agent-runtimes/claude-code-cli", { binaryPath: claude, enabled: true });
    const project = (await call<ProjectState>("POST", "/projects", { name: "Later", preset: "blank" })).body;
    const id = (await call<ConversationSummary>("POST", `/projects/${project.id}/conversations`, { model: { provider: "claude-code-cli", id: "sonnet" } })).body.id;
    const base = `/projects/${project.id}/conversations/${id}`;
    const scheduled = async () => (await call<ConversationDetail>("GET", base)).body.scheduledMessages;
    const schedule = async (prompt: string, at = Date.now() + 100) => expect((await call("POST", `${base}/scheduled-messages`, { prompt, at })).status).toBe(204);
    const log = () => readFile(`${claude}.log`, "utf8").catch(() => "");
    const idle = () => vi.waitFor(async () => expect((await call<ConversationDetail>("GET", base)).body.agent.status).toBe("idle"), { timeout: 5_000 });

    expect((await call("POST", `${base}/scheduled-messages`, { prompt: "   ", at: Date.now() })).status).toBe(400);
    expect((await call("POST", `/projects/${project.id}/conversations/missing/scheduled-messages`, { prompt: "Hello", at: Date.now() })).status).toBe(404);

    await schedule("Removed before its time", Date.now() + 60_000);
    const [removed] = await scheduled();
    expect((await call("DELETE", `${base}/scheduled-messages/${removed.id}`)).status).toBe(204);
    expect((await call("DELETE", `${base}/scheduled-messages/${removed.id}`)).status).toBe(404);

    // It waits for a running turn to end, and doesn't join it as a follow-up.
    expect(await call("POST", `${base}/turns`, { prompt: "Take a while" })).toMatchObject({ status: 202 });
    await vi.waitFor(async () => expect(await log()).toContain("Take a while"), { timeout: 5_000 });
    await schedule("Sent at its time");
    await pause(300);
    expect((await call<ConversationDetail>("GET", base)).body).toMatchObject({ pendingPrompts: [], scheduledMessages: [{ prompt: "Sent at its time" }] });
    await vi.waitFor(async () => expect(await log()).toContain("Sent at its time"), { timeout: 5_000 });
    expect((await log()).indexOf("finished")).toBeLessThan((await log()).indexOf("Sent at its time"));
    await vi.waitFor(async () => expect(await scheduled()).toEqual([]));
    await idle();
    expect(await log()).not.toContain("Removed before its time");

    // With the agent turned off it waits, and goes once the agent is back.
    await call("PATCH", "/agent-runtimes/claude-code-cli", { enabled: false });
    await schedule("Held while off");
    await pause(300);
    expect(await log()).not.toContain("Held while off");
    await expect(scheduled()).resolves.toMatchObject([{ prompt: "Held while off" }]);
    await call("PATCH", "/agent-runtimes/claude-code-cli", { enabled: true });
    await vi.waitFor(async () => expect(await log()).toContain("Held while off"), { timeout: 5_000 });
    await idle();

    // Archived past its time, it is dropped and doesn't come back with the conversation.
    await schedule("Dropped when archived", Date.now() + 300);
    expect((await call("POST", `${base}/archive`)).status).toBe(204);
    await pause(600);
    expect((await call("POST", `${base}/unarchive`)).status).toBe(200);
    await expect(scheduled()).resolves.toEqual([]);
    expect(await log()).not.toContain("Dropped when archived");
    await idle();

    // Due while OhMyGame was closed, it comes back as missed and isn't sent on startup.
    await schedule("Due while closed", Date.now() + 200);
    // One due after the restart, in a conversation not opened since, waits for the plan saved in its session.
    await schedule("Waits for the plan", Date.now() + 1_000);
    await app.close();
    await pause(300);
    const stored = new ConversationManager();
    stored.open(project, (await stored.get(project, id))!).appendCustomEntry("ohmygame-plan", { mode: "awaiting_approval", plan: { title: "Plan", steps: [] } });
    const reopened = createApp({ dataDirectory, piAgentDirectory: path.join(dataDirectory, "pi-agent"), accessToken: "app-token" });
    cleanup.push(() => reopened.close());
    await reopened.ready();
    await pause(1_500);
    expect(await log()).not.toContain("Due while closed");
    expect(await log()).not.toContain("Waits for the plan");
    const detail = await reopened.inject({ method: "GET", url: base, headers: { authorization: "Bearer app-token" } });
    expect((JSON.parse(detail.body) as ConversationDetail).scheduledMessages).toMatchObject([{ prompt: "Due while closed", missed: true }, { prompt: "Waits for the plan" }]);
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
