import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { probeModels } from "../src/daemon/agent-runtimes/discovery.js";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-model-cache-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = new AgentRuntimeService(root, () => undefined);
  await service.load();
  cleanup.push(() => service.close());
  const install = async (name: string) => {
    const binary = path.join(root, name);
    const catalog = binary + ".json",
      started = binary + ".started",
      gate = binary + ".gate";
    await writeFile(
      binary,
      `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("2.1.300"); process.exit(); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({loggedIn:true})); process.exit(); }
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  if (m.type !== "control_request") return;
  fs.writeFileSync(${JSON.stringify(started)}, "started");
  const reply = () => {
    if (fs.existsSync(${JSON.stringify(gate)})) return setTimeout(reply, 10);
    const models = JSON.parse(fs.readFileSync(${JSON.stringify(catalog)}, "utf8"));
    console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:m.request_id,response:{models}}}));
  };
  reply();
});
`,
      { mode: 0o700 },
    );
    const setModel = (value: string) =>
      writeFile(catalog, JSON.stringify([{ value, displayName: value }]));
    await setModel(name);
    return { binary, gate, started, setModel };
  };
  return { service, install };
}
it("refreshes direct model lookup after the catalog TTL expires", async () => {
  const { service, install } = await fixture();
  const cli = await install("claude-a");
  await service.update("claude-code-cli", {
    binaryPath: cli.binary,
    enabled: true,
  });
  expect(await service.model("claude-code-cli", "claude-a")).toBeDefined();
  await cli.setModel("changed");
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
  expect(await service.model("claude-code-cli", "changed")).toBeDefined();
  expect(await service.model("claude-code-cli", "claude-a")).toBeUndefined();
});
it("does not let an old in-flight catalog overwrite a newly selected executable", async () => {
  const { service, install } = await fixture();
  const old = await install("claude-old"),
    next = await install("claude-new");
  await service.update("claude-code-cli", {
    binaryPath: old.binary,
    enabled: true,
  });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
  await rm(old.started);
  await writeFile(old.gate, "hold");
  const stale = service.model("claude-code-cli", "claude-old");
  await expect
    .poll(() => readFile(old.started, "utf8").catch(() => ""))
    .toBe("started");
  await service.update("claude-code-cli", { binaryPath: next.binary });
  expect(await service.model("claude-code-cli", "claude-new")).toBeDefined();
  await rm(old.gate);
  expect(await stale).toBeUndefined();
  expect(await service.model("claude-code-cli", "claude-new")).toBeDefined();
  expect(await service.model("claude-code-cli", "claude-old")).toBeUndefined();
});

it("loads every page of the native Codex model catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-model-pages-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "codex");
  await writeFile(
    binary,
    `#!${process.execPath}
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === "thread/start" ? {thread:{id:"probe"},activePermissionProfile:{id:m.params.permissions}} : m.method === "model/list" ? (m.params.cursor ? {data:[{id:"second",supportedReasoningEfforts:[{reasoningEffort:"high"}]}]} : {data:[{id:"first"}],nextCursor:"page-2"}) : {};
  console.log(JSON.stringify({id:m.id,result}));
});
`,
    { mode: 0o700 },
  );
  const result = await probeModels(
    binary,
    "codex-cli",
    { PATH: process.env.PATH ?? "" },
    root,
    true,
  );
  expect(result.models.map((model) => model.id)).toEqual(["first", "second"]);
});

it("keeps the last reported usage limits across a restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-limits-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "agent-runtimes"), { recursive: true });
  const fiveHour = {
    id: "claude/five_hour",
    usedPercent: 13,
    windowMinutes: 300,
    resetsAt: 1792326600,
  };
  await writeFile(
    path.join(root, "agent-runtimes", "limits.json"),
    JSON.stringify({
      "claude-code-cli": [fiveHour, { id: 3 }],
      "unknown-cli": [fiveHour],
    }),
  );
  const service = new AgentRuntimeService(root, () => undefined);
  await service.load();
  cleanup.push(() => service.close());
  expect((await service.status("claude-code-cli")).limits).toEqual([fiveHour]);
  expect((await service.status("codex-cli")).limits).toBeUndefined();
});
