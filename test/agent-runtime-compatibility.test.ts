import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  AgentRuntimeCompatibilityError,
  checkRuntimeVersionRequirement,
} from "../src/daemon/agent-runtimes/compatibility.js";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-cli-compat-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "cli");
  const calls = path.join(root, "calls.jsonl");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst calls = ${JSON.stringify(calls)};\n${source}`,
    { mode: 0o700 },
  );
  const service = new AgentRuntimeService(root, () => undefined);
  await service.load();
  cleanup.push(() => service.close());
  const messages = async () =>
    (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { root, binary, service, messages };
}

const codex = (version: string, profile = true, failure = false) => `
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("codex-cli ${version}"); process.exit(); }
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(); }
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  fs.appendFileSync(calls, JSON.stringify(m) + "\\n");
  if (m.id === undefined) return;
  if (m.method === "turn/start") process.exit(99);
  if (m.method === "thread/start" && ${failure}) {
    console.log(JSON.stringify({id:m.id,error:{message:"Connection timed out while refreshing configuration"}}));
    return;
  }
  const result = m.method === "thread/start"
    ? { thread: { id: "probe" }, ...(${profile} ? {activePermissionProfile:{id:m.params.permissions}} : {}) }
    : m.method === "model/list" ? {data:[{id:"fixture-model"}]} : {};
  console.log(JSON.stringify({id:m.id,result}));
});`;

it("uses Claude's documented sandbox requirement only for modes that rely on it", () => {
  expect(() =>
    checkRuntimeVersionRequirement(
      "claude-code-cli",
      "2.1.82",
      "standard",
      "os",
    ),
  ).toThrow("sandbox.failIfUnavailable");
  expect(() =>
    checkRuntimeVersionRequirement(
      "claude-code-cli",
      "2.1.83",
      "standard",
      "os",
    ),
  ).not.toThrow();
  expect(() =>
    checkRuntimeVersionRequirement("claude-code-cli", "2.1.76", "full", "os"),
  ).not.toThrow();
  expect(() =>
    checkRuntimeVersionRequirement(
      "claude-code-cli",
      "2.1.76",
      "standard",
      "none",
    ),
  ).not.toThrow();
  expect(() =>
    checkRuntimeVersionRequirement(
      "codex-cli",
      "0.162.0-alpha.17.2",
      "standard",
      "os",
    ),
  ).not.toThrow();
  expect(() =>
    checkRuntimeVersionRequirement(
      "opencode-cli",
      "1.18.32",
      "standard",
      "none",
    ),
  ).not.toThrow();
  try {
    checkRuntimeVersionRequirement(
      "claude-code-cli",
      undefined,
      "standard",
      "os",
    );
    expect.fail(
      "An unknown version cannot establish the required sandbox behavior",
    );
  } catch (cause) {
    expect(cause).not.toBeInstanceOf(AgentRuntimeCompatibilityError);
    expect(String(cause)).toContain("could not verify");
  }
});

// These cases execute POSIX script fixtures; Windows cannot start them as native CLIs.
it.skipIf(process.platform === "win32")("accepts the reported Codex alpha by checking an ephemeral thread, not its version", async () => {
  const { service, binary, messages } = await fixture(
    codex("0.162.0-alpha.17.2"),
  );
  const status = await service.update("codex-cli", {
    enabled: true,
    binaryPath: binary,
  });
  expect(status).toMatchObject({
    version: "0.162.0-alpha.17.2",
    testedVersion: "0.163.0",
    diagnostics: [],
  });
  expect(await service.model("codex-cli", "fixture-model")).toBeDefined();
  const sent = await messages();
  const start = sent.find((message) => message.method === "thread/start");
  expect(start.params).toMatchObject({
    ephemeral: true,
    dynamicTools: [expect.objectContaining({ type: "function" })],
  });
  expect(sent.some((message) => message.method === "turn/start")).toBe(false);
  expect(
    sent.filter((message) => message.method === "thread/start"),
  ).toHaveLength(1);
});

it.skipIf(process.platform === "win32")("rejects a newer Codex that ignores permissions during setup, before offering its models", async () => {
  const { service, binary, messages } = await fixture(codex("99.0.0", false));
  const status = await service.update("codex-cli", {
    enabled: true,
    binaryPath: binary,
  });
  expect(status.diagnostics).toEqual([
    expect.objectContaining({
      code: "runtime-incompatible",
      capability: "permissions / activePermissionProfile",
    }),
  ]);
  expect(await service.model("codex-cli", "fixture-model")).toBeUndefined();
  expect((await service.models()).models).toEqual([]);
  expect(
    (await messages()).filter((message) => message.method === "thread/start"),
  ).toHaveLength(1);
  expect(
    (await messages()).some((message) => message.method === "turn/start"),
  ).toBe(false);
});

it.skipIf(process.platform === "win32")("keeps a temporary Codex probe failure distinct and retries on an explicit recheck", async () => {
  const { service, binary, messages } = await fixture(
    codex("0.162.0-alpha.17.2", true, true),
  );
  const status = await service.update("codex-cli", {
    enabled: true,
    binaryPath: binary,
  });
  expect(status.diagnostics).toEqual([
    expect.objectContaining({ code: "models-unavailable" }),
  ]);
  await service.models();
  expect(
    (await messages()).filter((message) => message.method === "thread/start"),
  ).toHaveLength(1);
  await writeFile(
    binary,
    `#!${process.execPath}\nconst calls = ${JSON.stringify(path.join(path.dirname(binary), "calls.jsonl"))};\n${codex("0.162.0-alpha.17.2")}`,
  );
  expect((await service.status("codex-cli", true)).diagnostics).toEqual([]);
  expect(await service.model("codex-cli", "fixture-model")).toBeDefined();
});

const opencode = (pure: boolean, callbacks = true, version = "1.18.32") => `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(calls, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("${version}"); process.exit(); }
if (args[0] === "serve" && args.includes("--help")) { console.log("opencode serve --hostname --port ${pure ? "--pure" : ""}"); process.exit(); }
if (args[0] === "models") { console.log('fixture/model\\n{"name":"Fixture","capabilities":{"toolcall":true},"variants":{"low":{}}}'); process.exit(); }
if (args[0] === "serve") {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  if (!${callbacks}) config.permission.read = "allow";
  const server = require("node:http").createServer((request,response) => {
    fs.appendFileSync(calls, JSON.stringify(request.url) + "\\n");
    if (request.url === "/path") return response.end(JSON.stringify({worktree:process.cwd()}));
    if (request.url === "/config") return response.end(JSON.stringify(config));
    if (request.url === "/event") {
      response.writeHead(200, {"content-type":"text/event-stream"});
      response.write('data: {"type":"server.connected"}\\n\\n');
      return;
    }
    response.writeHead(404); response.end();
  });
  server.listen(0,"127.0.0.1",() => console.log("opencode server listening on http://127.0.0.1:"+server.address().port));
} else
process.exit(99);`;

it.skipIf(process.platform === "win32")("accepts an older OpenCode that advertises the required serving and isolation flags", async () => {
  const { service, binary } = await fixture(opencode(true));
  const status = await service.update("opencode-cli", {
    enabled: true,
    binaryPath: binary,
  });
  expect(status).toMatchObject({
    version: "1.18.32",
    testedVersion: "1.18.33",
    diagnostics: [],
  });
  expect(await service.model("opencode-cli", "fixture/model")).toBeDefined();
});

it.skipIf(process.platform === "win32")("requires OpenCode's pure flag only when CLI configuration isolation is selected", async () => {
  const { service, binary } = await fixture(opencode(false));
  const status = await service.update("opencode-cli", {
    enabled: true,
    binaryPath: binary,
  });
  expect(status.diagnostics).toEqual([
    expect.objectContaining({
      code: "runtime-incompatible",
      capability: "--pure",
    }),
  ]);
  expect((await service.models()).models).toEqual([]);
  expect(
    (await service.update("opencode-cli", { isolateUserConfig: false }))
      .diagnostics,
  ).toEqual([]);
  expect(await service.model("opencode-cli", "fixture/model")).toBeDefined();
});

it.skipIf(process.platform === "win32")("rejects an OpenCode server that would bypass permission callbacks, even on a newer version", async () => {
  const { service, binary, messages } = await fixture(
    opencode(true, false, "99.0.0"),
  );
  const status = await service.update("opencode-cli", {
    enabled: true,
    binaryPath: binary,
  });
  expect(status.diagnostics).toEqual([
    expect.objectContaining({
      code: "runtime-incompatible",
      capability: "permission.read=ask",
    }),
  ]);
  expect((await service.models()).models).toEqual([]);
  const requests = (await messages()).filter(
    (message) => typeof message === "string",
  );
  expect(requests).toContain("/config");
  expect(requests.some((route) => route.startsWith("/session"))).toBe(false);
});
