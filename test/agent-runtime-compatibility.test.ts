import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  AgentRuntimeCompatibilityError,
  checkRuntimeVersionRequirement,
  cliProbeError,
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

it("treats only a rejected command as incompatible, not a transient failure", () => {
  expect(
    cliProbeError("Codex", "error: unexpected argument '--fixture'"),
  ).toBeInstanceOf(AgentRuntimeCompatibilityError);
  expect(cliProbeError("Codex", "Connection timed out")).not.toBeInstanceOf(
    AgentRuntimeCompatibilityError,
  );
});

it("checks a version only for OpenCode's API generation", () => {
  expect(() =>
    checkRuntimeVersionRequirement("claude-code-cli", undefined),
  ).not.toThrow();
  expect(() =>
    checkRuntimeVersionRequirement("codex-cli", "0.162.0-alpha.17.2"),
  ).not.toThrow();
  expect(() =>
    checkRuntimeVersionRequirement("opencode-cli", "2.1.0"),
  ).not.toThrow();
  expect(() => checkRuntimeVersionRequirement("opencode-cli", undefined)).toThrow(
    "did not report",
  );
});

it.each(["1.18.33", "2.0.29", "3.0.0-beta.1", "3.0.0"])(
  "rejects unsupported OpenCode API generation %s",
  (version) => {
    expect(() =>
      checkRuntimeVersionRequirement("opencode-cli", version),
    ).toThrow("unsupported");
  },
);

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

const opencode = (version = "2.1.0", agents = ["build", "plan"]) => `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(calls, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("opencode v${version}"); process.exit(); }
if (args[0] === "serve") {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
  fs.appendFileSync(calls, JSON.stringify({ config: Object.keys(config) }) + "\\n");
  const server = require("node:http").createServer((request,response) => {
    const url = new URL(request.url, "http://localhost");
    fs.appendFileSync(calls, JSON.stringify(url.pathname) + "\\n");
    if (url.pathname === "/api/info") return response.end(JSON.stringify({version:"${version}"}));
    if (url.pathname === "/api/location") return response.end(JSON.stringify({directory:process.cwd(),project:{id:"project",directory:process.cwd()}}));
    if (url.pathname === "/api/agent") return response.end(JSON.stringify({data:${JSON.stringify(agents)}.map((id) => ({id}))}));
    if (url.pathname === "/api/model") return response.end(JSON.stringify({data:[{providerID:"fixture",id:"model",name:"Fixture",enabled:true,capabilities:{tools:true},variants:[{id:"low"}]}]}));
    if (url.pathname === "/api/event") {
      response.writeHead(200, {"content-type":"text/event-stream"});
      response.write('data: {"type":"server.connected","data":{}}\\n\\n');
      return;
    }
    response.writeHead(404); response.end();
  });
  server.listen(0,"127.0.0.1",() => console.log(JSON.stringify({url:"http://127.0.0.1:"+server.address().port})));
  process.stdin.resume();
  process.stdin.on("end",()=>process.exit());
} else process.exit(99);`;

it.skipIf(process.platform === "win32")(
  "discovers v2 models on a private server without v1 flags, sessions or inference",
  async () => {
    const { service, binary, messages } = await fixture(opencode());
    const status = await service.update("opencode-cli", {
      enabled: true,
      binaryPath: binary,
    });
    expect(status).toMatchObject({
      version: "2.1.0",
      diagnostics: [],
    });
    expect(await service.model("opencode-cli", "fixture/model")).toBeDefined();
    const sent = await messages();
    expect(sent).toContainEqual([
      "serve",
      "--stdio",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    expect(sent).toContain("/api/model");
    expect(
      sent.some(
        (message) =>
          typeof message === "string" && message.startsWith("/api/session"),
      ),
    ).toBe(false);
    // OpenCode keeps the person's own permission rules and saved grants.
    expect(sent).toContainEqual({
      config: ["share", "snapshots", "instructions"],
    });
    expect(sent).not.toContain("/api/permission/saved");
  },
);

it.skipIf(process.platform === "win32")(
  "rejects v1 explicitly",
  async () => {
    const { service, binary, messages } = await fixture(
      opencode("1.18.33"),
    );
    const status = await service.update("opencode-cli", {
      enabled: true,
      binaryPath: binary,
    });
    expect(status.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "runtime-incompatible",
        capability: "OpenCode HTTP API v2 (>=2.1.0 <3)",
      }),
    );
    expect((await service.models()).models).toEqual([]);
    expect(
      (await messages()).some((m) => Array.isArray(m) && m[0] === "serve"),
    ).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "waits for OpenCode's build and plan agents before using it",
  async () => {
    const { service, binary, messages } = await fixture(
      opencode("2.1.0", ["build"]),
    );
    const status = await service.update("opencode-cli", {
      enabled: true,
      binaryPath: binary,
    });
    expect(status.diagnostics).toEqual([
      expect.objectContaining({
        code: "runtime-incompatible",
        capability: "build/plan agents",
      }),
    ]);
    expect((await service.models()).models).toEqual([]);
    expect(await messages()).toContain("/api/agent");
  },
);
