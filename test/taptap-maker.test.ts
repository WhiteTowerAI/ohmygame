import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error The plugin's native code is plain JavaScript.
import * as maker from "../plugins-v2/taptap-maker/native/maker.mjs";
// @ts-expect-error The plugin's native code is plain JavaScript.
import { Cancelled, lingering, withLock } from "../plugins-v2/taptap-maker/native/runtime.mjs";

let directory: string, workspace: string;
let progress: { message: string; url?: string }[];
const context = (signal?: AbortSignal) => ({
  directory,
  workspace,
  signal,
  progress: (message: string, url?: string) => progress.push({ message, ...(url ? { url } : {}) }),
});

// A stand-in for the Maker CLI in the plugin's data folder; it records every call.
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "omg-maker-"));
  workspace = path.join(directory, "workspace");
  progress = [];
  process.env.MAKER_TEST_DIRECTORY = directory;
  const cli = path.join(directory, "tools/node_modules/@taptap/maker");
  const python = path.join(directory, "python", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await mkdir(path.join(cli, "bin"), { recursive: true });
  await mkdir(path.dirname(python), { recursive: true });
  await mkdir(workspace);
  await writeFile(python, "");
  await writeFile(path.join(cli, "package.json"), JSON.stringify({ version: "0.0.39", type: "module" }));
  await writeFile(
    path.join(cli, "bin/taptap-maker"),
    `
    import { appendFile, mkdir, writeFile, access } from "node:fs/promises";
    import path from "node:path";
    const args = process.argv.slice(2);
    const file = (name) => path.join(process.env.MAKER_TEST_DIRECTORY, name);
    const has = (name) => access(file(name)).then(() => true, () => false);
    await appendFile(file("calls.jsonl"), JSON.stringify(args) + "\\n");
    if (args[0] === "lua-lsp") console.log(JSON.stringify({ ready: true }));
    else if (args[0] === "apps") {
      if (await has("signed-out")) { console.error("JWT missing"); process.exit(1); }
      if (await has("leave-running")) {
        // Like the preview Runtime: started by Maker, it outlives the call and holds its output.
        // On Windows a child outlives its parent only when detached; a failed
        // start leaves one that isn't, which Windows ends with its parent.
        const { spawn } = await import("node:child_process");
        const failing = await has("fail-after-start");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", detached: process.platform === "win32" && !failing });
        child.unref();
        await writeFile(file("child.pid"), String(child.pid));
        if (failing) process.exit(1);
      }
      console.log(JSON.stringify([{ id: "selected", name: "Selected" }]));
    } else if (args[0] === "login") console.log(JSON.stringify({ message: "Open https://maker.example.com/device?code=AB12 to sign in" }));
    else if (args[0] === "init") {
      if (await has("hang-init")) {
        // Something it started keeps running with its output.
        const { spawn } = await import("node:child_process");
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
        await writeFile(file("child.pid"), String(child.pid));
        await writeFile(file("init.pid"), String(process.pid));
        await new Promise(() => {});
      }
      if (await has("fail-before-selection")) process.exit(1);
      const workspace = args[args.indexOf("--target-dir") + 1];
      const id = args.includes("--create") ? "created" : args[args.indexOf("--app-id") + 1];
      console.log(JSON.stringify({step:"app",data:{app_id:id}}));
      // Like Maker, init sets up a repository in the folder and keeps its files.
      await mkdir(path.join(workspace, ".git/info"), { recursive: true });
      await mkdir(path.join(workspace, ".maker-mcp"), { recursive: true });
      await writeFile(path.join(workspace, ".maker-mcp/config.json"), JSON.stringify({ project_id: id }));
      if (await has("fail-init")) process.exit(1);
      console.log("{}");
    } else if (args[0] === "preview") {
      // The preview's state lives in preview.json; start fails while start-failures counts down.
      const { readFile } = await import("node:fs/promises");
      const state = async () => JSON.parse(await readFile(file("preview.json"), "utf8"));
      if (args[1] === "status") {
        const value = await state();
        console.log(JSON.stringify(value));
        if (value.state === "failed") process.exitCode = 1;
      } else if (args[1] === "install") {
        // install-fails: the install fails and leaves the old install metadata.
        if (await has("install-fails")) process.exitCode = 1;
      } else if (args[1] === "start" || args[1] === "refresh") {
        // Like Maker, a refresh stops the runtime first and has nothing to refresh once it is gone.
        const left = Number(await readFile(file("start-failures"), "utf8").catch(() => "0"));
        if (args[1] === "refresh" && !(await state()).process_alive) {
          await writeFile(file("preview.json"), JSON.stringify({ state: "failed", process_alive: false, install_state: "ready", error: "No running preview to refresh" }));
          process.exitCode = 1;
        // start-silent: the start fails before Maker records anything.
        } else if (await has("start-silent")) process.exitCode = 1;
        else if (left > 0) {
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
  delete process.env.MAKER_TEST_DIRECTORY;
  await rm(directory, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function calls(): Promise<string[][]> {
  return (await readFile(path.join(directory, "calls.jsonl"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const inits = async () => (await calls()).filter((args) => args[0] === "init");

describe("TapTap Maker project setup", () => {
  it("creates and initializes a new Maker project in a project holding only the app's files", async () => {
    await writeFile(path.join(workspace, "ohmygame.json"), "{}");
    expect(await maker.ready(context())).toMatchObject({ ready: false, message: expect.stringContaining("Connect this project") });
    expect(await maker.create(context(), { name: "Pixel garden" })).toEqual({ connection: "ready", project: { id: "created" } });
    expect(await inits()).toEqual([
      ["init", "--create", "--name", "Pixel garden", "--target-dir", workspace, "--skip-mcp-install", "--skip-confirm", "--json"],
    ]);
    await maker.create(context(), { name: "Pixel garden" });
    expect(await inits()).toHaveLength(1);
    expect(await maker.ready(context())).toEqual({ ready: true });
  });

  it("resumes a failed checkout using the created identity and keeps local files", async () => {
    await writeFile(path.join(directory, "fail-init"), "");
    await expect(maker.create(context(), { name: "Pixel garden" })).rejects.toThrow();
    expect(await maker.status(context())).toMatchObject({ project: null });
    expect(await maker.ready(context())).toMatchObject({ ready: false });
    await writeFile(path.join(workspace, "game.lua"), "-- kept");
    await rm(path.join(directory, "fail-init"));
    expect(await maker.create(context(), { name: "Pixel garden" })).toMatchObject({ project: { id: "created" } });
    const invoked = await inits();
    expect(invoked).toHaveLength(2);
    expect(invoked[1]).toEqual(expect.arrayContaining(["--app-id", "created"]));
    expect(invoked[1]).not.toContain("--create");
    expect(await readFile(path.join(workspace, "game.lua"), "utf8")).toBe("-- kept");
  });

  it("never repeats a create whose outcome is unknown, and lets the person connect the project instead", async () => {
    await writeFile(path.join(directory, "fail-before-selection"), "");
    await expect(maker.create(context(), { name: "Pixel garden" })).rejects.toThrow();
    await rm(path.join(directory, "fail-before-selection"));
    await expect(maker.create(context(), { name: "Pixel garden" })).rejects.toThrow("outcome is unknown");
    expect((await calls()).filter((args) => args.includes("--create"))).toHaveLength(1);
    expect(await maker.bind(context(), { projectId: "selected" })).toMatchObject({ project: { id: "selected" } });
  });

  it("connects a project with files of its own, keeping them out of Maker's commits", async () => {
    await writeFile(path.join(workspace, "ohmygame.json"), "{}");
    await writeFile(path.join(workspace, "notes.md"), "kept");
    await maker.create(context(), { name: "Pixel garden" });
    expect(await readFile(path.join(workspace, "notes.md"), "utf8")).toBe("kept");
    const exclude = path.join(workspace, ".git/info/exclude");
    expect((await readFile(exclude, "utf8")).split("\n")).toEqual(
      expect.arrayContaining(["/ohmygame.json", "/.ohmygame/", "/canvas/"]),
    );
    await writeFile(exclude, "*.log\n/canvas/");
    await maker.ready(context());
    await maker.status(context());
    const lines = (await readFile(exclude, "utf8")).trim().split("\n");
    expect(lines.filter((line) => line === "/canvas/")).toHaveLength(1);
    expect(lines).toEqual(["*.log", "/canvas/", "# OhMyGame's own files, kept out of Maker builds", "/ohmygame.json", "/.ohmygame/"]);
  });

  it("finds a worktree's shared exclude file and keeps rules Git reads differently", async () => {
    await maker.bind(context(), { projectId: "selected" });
    // A worktree's .git is a file; its Git folder names the main repository's.
    const main = path.join(directory, "main.git");
    await mkdir(path.join(main, "worktrees/workspace"), { recursive: true });
    await writeFile(path.join(main, "worktrees/workspace/commondir"), "../..\n");
    await rm(path.join(workspace, ".git"), { recursive: true });
    await writeFile(path.join(workspace, ".git"), `gitdir: ${path.join(main, "worktrees/workspace")}\n`);
    await mkdir(path.join(main, "info"));
    // Leading spaces are part of a Git pattern, so this rule matches nothing.
    await writeFile(path.join(main, "info/exclude"), " /ohmygame.json\n/canvas/   \n");
    expect(await maker.ready(context())).toEqual({ ready: true });
    expect((await readFile(path.join(main, "info/exclude"), "utf8")).split("\n")).toEqual([
      " /ohmygame.json",
      "/canvas/   ",
      "# OhMyGame's own files, kept out of Maker builds",
      "/ohmygame.json",
      "/.ohmygame/",
      "",
    ]);
  });

  it("refuses a folder that is already a Git repository before calling Maker", async () => {
    await mkdir(path.join(workspace, ".git"));
    await expect(maker.create(context(), { name: "Pixel garden" })).rejects.toThrow("already a Git repository");
    await expect(maker.bind(context(), { projectId: "selected" })).rejects.toThrow("already a Git repository");
    expect(await calls()).toEqual([]);
  });

  it("refuses a repository that replaced a connected folder, whatever an earlier setup recorded", async () => {
    await maker.bind(context(), { projectId: "selected" });
    await rm(workspace, { recursive: true });
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    const before = (await calls()).length;
    await expect(maker.bind(context(), { projectId: "selected" })).rejects.toThrow("already a Git repository");
    await expect(maker.create(context(), { name: "Pixel garden" })).rejects.toThrow("already a Git repository");
    expect(await calls()).toHaveLength(before);
  });

  it("initializes once and keeps the binding when the same project is connected again", async () => {
    await maker.bind(context(), { projectId: "selected" });
    const bindingPath = path.join(workspace, ".maker-mcp/config.json");
    const original = await readFile(bindingPath, "utf8");
    await writeFile(path.join(workspace, "game.lua"), "-- local changes");
    expect(await maker.bind(context(), { projectId: "selected" })).toEqual({ connection: "ready", project: { id: "selected", name: "Selected" } });
    expect(await inits()).toHaveLength(1);
    expect(await readFile(bindingPath, "utf8")).toBe(original);
    await expect(maker.bind(context(), { projectId: "another" })).rejects.toThrow("already bound to another Maker project");
    expect(await inits()).toHaveLength(1);
  });

  it("reports a signed-out account and passes on Maker's sign-in link", async () => {
    await writeFile(path.join(directory, "signed-out"), "");
    expect(await maker.status(context())).toEqual({ connection: "needs-auth", project: null });
    await rm(path.join(directory, "signed-out"));
    await maker.signIn(context());
    expect(progress).toEqual([{ message: "Complete Maker authorization in your browser.", url: "https://maker.example.com/device?code=AB12" }]);
  });

  it("stops Maker when a call is cancelled, and says what may be left", async () => {
    await writeFile(path.join(directory, "hang-init"), "");
    const controller = new AbortController();
    const creating = maker.create(context(controller.signal), { name: "Pixel garden" });
    const pidFile = path.join(directory, "init.pid");
    let pid = 0;
    for (let tries = 0; !pid && tries < 100; tries++) {
      pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const child = Number(await readFile(path.join(directory, "child.pid"), "utf8"));
    controller.abort();
    await expect(creating).rejects.toBeInstanceOf(Cancelled);
    await expect.poll(() => alive(pid)).toBe(false);
    await expect.poll(() => alive(child)).toBe(false);
  }, 15_000);

  it("ends a call once Maker exits, leaving running what Maker started", async () => {
    await writeFile(path.join(directory, "leave-running"), "");
    expect(await maker.projects(context())).toEqual({ projects: [{ id: "selected", name: "Selected" }] });
    const child = Number(await readFile(path.join(directory, "child.pid"), "utf8"));
    try {
      expect(alive(child)).toBe(true);
    } finally {
      if (alive(child)) process.kill(child, "SIGKILL");
    }
  }, 15_000);

  it("stops what Maker started when Maker fails", async () => {
    await writeFile(path.join(directory, "leave-running"), "");
    await writeFile(path.join(directory, "fail-after-start"), "");
    await expect(maker.projects(context())).rejects.toThrow();
    const child = Number(await readFile(path.join(directory, "child.pid"), "utf8"));
    await expect.poll(() => alive(child)).toBe(false);
  }, 15_000);

  it("takes over a lock whose process is gone", async () => {
    await writeFile(path.join(directory, "prepare.lock"), "999999999");
    let ran = false;
    await withLock(directory, "prepare", async () => { ran = true; });
    expect(ran).toBe(true);
    await expect(readFile(path.join(directory, "prepare.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets only one of several waiters take over a stale lock at a time", async () => {
    await writeFile(path.join(directory, "prepare.lock"), "999999999");
    let inside = 0;
    let most = 0;
    await Promise.all(Array.from({ length: 6 }, () => withLock(directory, "prepare", async () => {
      most = Math.max(most, ++inside);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inside--;
    })));
    expect(most).toBe(1);
  }, 15_000);

  it("waits out a lock file another process is deleting, which Windows reports as EPERM", () => {
    expect(lingering({ code: "EPERM" }, "win32")).toBe(true);
    // Elsewhere EPERM means the folder can't be written, which waiting won't change.
    expect(lingering({ code: "EPERM" }, "linux")).toBe(false);
    expect(lingering({ code: "EACCES" }, "win32")).toBe(false);
    expect(lingering({ code: "EEXIST" }, "win32")).toBe(false);
  });

  it("lets one project at a time hold the data folder's lock", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withLock(directory, "prepare", () => new Promise<void>((resolve) => { order.push("first"); release = resolve; }));
    await expect.poll(() => order.length).toBe(1);
    let waited = false;
    const second = withLock(directory, "prepare", async () => { order.push("second"); }, { onWait: () => { waited = true; } });
    await expect.poll(() => waited).toBe(true);
    expect(order).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("TapTap Maker preview", () => {
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
    expect(await maker.preview(context(), "start")).toEqual({ status: "running" });
    expect(progress.some(({ message }) => /Retrying/.test(message))).toBe(true);
    expect(await starts()).toBe(2);
  }, 15_000);

  it("shows Maker's own diagnosis of a failed preview, without credentials and without retrying", async () => {
    await preview({ state: "stopped", process_alive: false });
    await failStart(1, "Local prepare failed; no Runtime was started. Log: https://user:secret@example.com/log?token=abc");
    const result = await maker.preview(context(), "start");
    expect(result.status).toBe("error");
    expect(result.message).toContain("no Runtime was started");
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("abc");
    expect(await starts()).toBe(1);
  });

  it("starts the preview again when a refresh failed after Maker stopped it", async () => {
    await preview({ state: "running", process_alive: true });
    await failStart(1, "Local prepare failed; Public source index download failed (network).");
    expect(await maker.preview(context(), "refresh")).toEqual({ status: "running" });
    expect((await calls()).filter((args) => args[0] === "preview" && args[1] !== "status").map((args) => args[1])).toEqual(["refresh", "start"]);
  }, 15_000);

  it("reports a failed start or install that the status still describes from before", async () => {
    await preview({ state: "failed", process_alive: false, error: "Previous preview processes are no longer running. The stale session was retired safely." });
    await writeFile(path.join(directory, "start-silent"), "1");
    await expect(maker.preview(context(), "start")).rejects.toThrow();
    // install_state "ready" is left from an earlier install.
    await writeFile(path.join(directory, "install-fails"), "1");
    await expect(maker.preview(context(), "install")).rejects.toThrow();
  });

  it("hides credentials in query names Maker printed encoded", async () => {
    await preview({ state: "stopped", process_alive: false });
    await failStart(1, "Local prepare failed; no Runtime was started. Log: https://example.com/log?to%6Ben=abc&client_se%63ret=x'yz&page=2");
    const { message } = await maker.preview(context(), "start");
    expect(message).not.toContain("abc");
    expect(message).not.toContain("yz");
    expect(message).toContain("page=2");
  });

  it("treats a preview whose window was closed as stopped, so it can start again", async () => {
    await preview({ state: "failed", process_alive: false, error: "Previous preview processes are no longer running. The stale session was retired safely." });
    expect(await maker.preview(context(), "status")).toEqual({ status: "stopped" });
  });
});
