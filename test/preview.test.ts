import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewManager } from "../src/daemon/preview.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";

const managers: PreviewManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
});

describe("PreviewManager", () => {
  it("starts and stops a preview process tree", async () => {
    const workspacePath = await createWorkspace(false);
    const project = createProject(workspacePath);
    const manager = new PreviewManager(new RuntimeEventBus(), { readinessTimeoutMs: 2_000 });
    managers.push(manager);

    const url = await manager.start(project);
    expect(await (await fetch(url)).text()).toBe("ready");
    await manager.stop(project);
    expect(project.preview).toEqual({ status: "stopped" });
    await expect(fetch(url, { signal: AbortSignal.timeout(200) })).rejects.toThrow();
  });

  it("cleans up the process when readiness fails", async () => {
    const workspacePath = await createWorkspace(true);
    const project = createProject(workspacePath);
    const manager = new PreviewManager(new RuntimeEventBus(), { readinessTimeoutMs: 1_000 });
    managers.push(manager);

    await expect(manager.start(project)).rejects.toThrow(/did not become ready[\s\S]*server error/);
    const pid = Number(await readFile(path.join(workspacePath, "server.pid"), "utf8"));
    await vi.waitFor(() => expect(isProcessRunning(pid)).toBe(false));
    expect(project.preview.status).toBe("error");
    expect(project.preview.error).toContain("server error");
  });

});

async function createWorkspace(fail: boolean): Promise<string> {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "open-game-preview-"));
  await mkdir(path.join(workspacePath, "node_modules", ".bin"), { recursive: true });
  await writeFile(path.join(workspacePath, "node_modules", ".bin", "vite"), "");
  await writeFile(path.join(workspacePath, "package.json"), JSON.stringify({
    private: true,
    scripts: { dev: "node server.mjs" },
  }));
  if (fail) await writeFile(path.join(workspacePath, "fail"), "");
  await writeFile(path.join(workspacePath, "server.mjs"), `
    import { existsSync, writeFileSync } from "node:fs";
    import { createServer } from "node:http";
    const portIndex = process.argv.indexOf("--port");
    const port = Number(process.argv[portIndex + 1]);
    writeFileSync("server.pid", String(process.pid));
    console.log("server output 1");
    console.log("server output 2");
    console.error("server error");
    createServer((_request, response) => {
      response.statusCode = existsSync("fail") ? 500 : 200;
      response.end("ready");
    }).listen(port, "127.0.0.1");
  `);
  return workspacePath;
}

function createProject(workspacePath: string): ProjectState {
  return {
    id: path.basename(workspacePath),
    name: "Preview",
    type: "general",
    updatedAt: new Date(0).toISOString(),
    workspacePath,
    preview: { status: "stopped" },
  };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
