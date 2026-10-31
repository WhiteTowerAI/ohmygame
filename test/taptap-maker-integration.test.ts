import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginIntegrationMessage } from "../src/shared/plugin-integration.js";

let directory: string, workspace: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "omg-maker-binding-"));
  workspace = path.join(directory, "workspace");
  const cli = path.join(directory, "tools/node_modules/@taptap/maker");
  const python = path.join(
    directory,
    "python",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  await mkdir(path.join(cli, "bin"), { recursive: true });
  await mkdir(path.dirname(python), { recursive: true });
  await mkdir(workspace);
  await writeFile(python, "");
  await writeFile(
    path.join(cli, "package.json"),
    JSON.stringify({ version: "0.0.36", type: "module" }),
  );
  await writeFile(
    path.join(cli, "bin/taptap-maker"),
    `
    import { appendFile, mkdir, writeFile, access } from "node:fs/promises";
    import path from "node:path";
    const args = process.argv.slice(2);
    await appendFile(path.join(process.env.MAKER_TEST_DIRECTORY, "calls.jsonl"), JSON.stringify(args) + "\\n");
    if (args[0] === "lua-lsp") console.log(JSON.stringify({ ready: true }));
    else if (args[0] === "apps") console.log(JSON.stringify([{ id: "selected" }]));
    else if (args[0] === "init") {
      const failure = await access(path.join(process.env.MAKER_TEST_DIRECTORY, "fail-init")).then(() => true, () => false);
      const early = await access(path.join(process.env.MAKER_TEST_DIRECTORY, "fail-before-selection")).then(() => true, () => false);
      if (early) process.exit(1);
      const workspace = args[args.indexOf("--target-dir") + 1];
      const id = args.includes("--create") ? "created" : args[args.indexOf("--app-id") + 1];
      console.log(JSON.stringify({step:"app",data:{app_id:id}}));
      await mkdir(path.join(workspace, ".maker-mcp"), { recursive: true });
      await writeFile(path.join(workspace, ".maker-mcp/config.json"), JSON.stringify({ project_id: id }));
      if (failure) process.exit(1);
      console.log("{}");
    } else if (args[0] === "preview") {
      // The preview's state lives in preview.json; start fails while start-failures counts down.
      const { readFile } = await import("node:fs/promises");
      const file = (name) => path.join(process.env.MAKER_TEST_DIRECTORY, name);
      const state = async () => JSON.parse(await readFile(file("preview.json"), "utf8"));
      if (args[1] === "status") {
        const value = await state();
        console.log(JSON.stringify(value));
        if (value.state === "failed") process.exitCode = 1;
      } else if (args[1] === "start") {
        const left = Number(await readFile(file("start-failures"), "utf8").catch(() => "0"));
        if (left > 0) {
          await writeFile(file("start-failures"), String(left - 1));
          await writeFile(file("preview.json"), JSON.stringify({ state: "failed", process_alive: false, install_state: "ready", error: await readFile(file("start-error"), "utf8") }));
          process.exitCode = 1;
        } else await writeFile(file("preview.json"), JSON.stringify({ state: "running", process_alive: true, install_state: "ready" }));
      } else process.exitCode = 1;
    } else process.exitCode = 1;
  `,
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function run(action: "bind" | "create" | "status" | `preview-${string}`, projectId?: string) {
  const child = spawn(
    "node",
    [path.resolve("plugins/taptap-maker/scripts/integration.mjs")],
    {
      env: { ...process.env, MAKER_TEST_DIRECTORY: directory },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.resume();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(
    JSON.stringify({
      version: 1,
      action,
      dataDirectory: directory,
      workspacePath: workspace,
      configuration: {},
      projectId,
      projectName: "Pixel garden",
    }),
  );
  const code = await closed;
  return {
    code,
    messages: output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as PluginIntegrationMessage),
  };
}
const bind = (projectId: string) => run("bind", projectId);
async function calls(): Promise<string[][]> {
  return (await readFile(path.join(directory, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("Maker binding adapter", () => {
  it("creates and initializes a new Maker project without selecting an existing one", async () => {
    expect((await run("create")).code).toBe(0);
    const invoked = (await calls()).filter((args) => args[0] === "init");
    expect(invoked).toEqual([
      [
        "init",
        "--create",
        "--name",
        "Pixel garden",
        "--target-dir",
        workspace,
        "--skip-mcp-install",
        "--skip-confirm",
        "--json",
      ],
    ]);
    expect((await run("create")).code).toBe(0);
    expect((await calls()).filter((args) => args[0] === "init")).toHaveLength(
      1,
    );
  });
  it("resumes a failed checkout using the created identity and preserves local files", async () => {
    await writeFile(path.join(directory, "fail-init"), "");
    expect((await run("create")).code).toBe(1);
    expect((await run("status")).messages.at(-1)).toMatchObject({
      type: "result",
      result: { project: null },
    });
    await writeFile(path.join(workspace, "game.lua"), "-- preserved");
    await rm(path.join(directory, "fail-init"));
    expect((await run("create")).messages.at(-1)).toMatchObject({
      type: "result",
      result: { project: { id: "created" } },
    });
    const invoked = (await calls()).filter((args) => args[0] === "init");
    expect(invoked).toHaveLength(2);
    expect(invoked[1]).toContain("--app-id");
    expect(invoked[1]).toContain("created");
    expect(invoked[1]).not.toContain("--create");
    expect(await readFile(path.join(workspace, "game.lua"), "utf8")).toBe(
      "-- preserved",
    );
  });
  it("does not repeat an uncertain create and lets the user recover by selecting an existing project", async () => {
    await writeFile(path.join(directory, "fail-before-selection"), "");
    expect((await run("create")).code).toBe(1);
    await rm(path.join(directory, "fail-before-selection"));
    expect((await run("create")).messages.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("outcome is unknown"),
    });
    expect(
      (await calls()).filter((args) => args.includes("--create")),
    ).toHaveLength(1);
    expect((await bind("selected")).code).toBe(0);
  });
  it("rejects a nonempty unbound directory before creating a remote project", async () => {
    await writeFile(path.join(workspace, "game.lua"), "-- preserve");
    expect((await run("create")).code).toBe(1);
    await expect(
      readFile(path.join(directory, "calls.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("initializes once and preserves the existing binding on a repeated connection", async () => {
    const first = await bind("selected");
    expect(first.code).toBe(0);
    const bindingPath = path.join(workspace, ".maker-mcp/config.json");
    const original = await readFile(bindingPath, "utf8");
    await writeFile(path.join(workspace, "game.lua"), "-- local changes");
    const second = await bind("selected");
    expect(second.code).toBe(0);
    expect(second.messages.at(-1)).toMatchObject({
      type: "result",
      result: { project: { id: "selected" }, connection: { status: "ready" } },
    });
    const invoked = await calls();
    expect(invoked.filter((args) => args[0] === "init")).toHaveLength(1);
    expect(invoked[0]).toEqual(["lua-lsp", "doctor", "--json"]);
    expect(await readFile(bindingPath, "utf8")).toBe(original);
    expect(await readFile(path.join(workspace, "game.lua"), "utf8")).toBe(
      "-- local changes",
    );
  });
  it("rejects a different remote project without running initialization", async () => {
    expect((await bind("selected")).code).toBe(0);
    const before = await calls();
    const other = await bind("another");
    expect(other.code).toBe(1);
    expect(other.messages.at(-1)).toMatchObject({
      type: "error",
      message: "This directory is already bound to another Maker project",
    });
    expect(await calls()).toEqual(before);
  });
});

describe("Maker preview adapter", () => {
  beforeEach(async () => {
    await mkdir(path.join(workspace, ".maker-mcp"), { recursive: true });
    await writeFile(path.join(workspace, ".maker-mcp/config.json"), JSON.stringify({ project_id: "selected" }));
  });
  const preview = (value: object) => writeFile(path.join(directory, "preview.json"), JSON.stringify({ install_state: "ready", ...value }));
  const failStart = async (times: number, error: string) => {
    await writeFile(path.join(directory, "start-failures"), String(times));
    await writeFile(path.join(directory, "start-error"), error);
  };
  const starts = async () => (await calls()).filter((args) => args[0] === "preview" && args[1] === "start").length;

  it("tries again when Maker couldn't download its sources, then reports the running preview", async () => {
    await preview({ state: "stopped", process_alive: false });
    await failStart(1, "Local prepare failed; Public source index download failed (network). Log: /tmp/prepare.log");
    const result = await run("preview-start");
    expect(result.messages.some((message) => message.type === "progress" && /Retrying/.test(message.message))).toBe(true);
    expect(result.messages.at(-1)).toMatchObject({ type: "result", result: { preview: { status: "running" } } });
    expect(await starts()).toBe(2);
  }, 15_000);

  it("shows Maker's own diagnosis of a failed preview instead of a generic error, without retrying it", async () => {
    await preview({ state: "stopped", process_alive: false });
    await failStart(1, "Local prepare failed; no Runtime was started. Log: https://user:secret@example.com/log?token=abc");
    const result = await run("preview-start");
    expect(result.code).toBe(0);
    const message = (result.messages.at(-1) as { result: { preview: { status: string; message: string } } }).result.preview;
    expect(message.status).toBe("error");
    expect(message.message).toContain("no Runtime was started");
    // Credentials in a URL never reach the page.
    expect(message.message).not.toContain("secret");
    expect(message.message).not.toContain("abc");
    expect(await starts()).toBe(1);
  });

  it("treats a preview whose window was closed as stopped, so it can start again", async () => {
    await preview({ state: "failed", process_alive: false, error: "Previous preview processes are no longer running. The stale session was retired safely." });
    expect((await run("preview-status")).messages.at(-1)).toEqual({ version: 1, type: "result", result: { preview: { status: "stopped" } } });
  });
});
