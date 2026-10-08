import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe("player preview startup", () => {
  it("reuses a development server for concurrent opens without changing its URL or process", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-player-preview-"));
    const app = createApp({ dataDirectory });
    cleanups.push(async () => { await app.close(); await rm(dataDirectory, { recursive: true, force: true }); });
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Player test" } })).json();
    await mkdir(path.join(project.workspacePath, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "node_modules", ".bin", "vite"), "");
    await writeFile(path.join(project.workspacePath, "package.json"), JSON.stringify({ scripts: { dev: "node server.mjs" } }));
    await writeFile(path.join(project.workspacePath, "server.mjs"), `
      import { createServer } from "node:http";
      import { writeFileSync } from "node:fs";
      writeFileSync("server.pid", String(process.pid));
      createServer((_request, response) => response.end("game")).listen(Number(process.argv[process.argv.indexOf("--port") + 1]), "127.0.0.1");
    `);
    const open = () => app.inject({ method: "POST", url: `/projects/${project.id}/preview?reuse=1` });
    const [first, concurrent] = await Promise.all([open(), open()]);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().title).toBe("Player test");
    expect(concurrent.json().url).toBe(first.json().url);
    const pid = await readFile(path.join(project.workspacePath, "server.pid"), "utf8");
    expect((await open()).json().url).toBe(first.json().url);
    expect(await readFile(path.join(project.workspacePath, "server.pid"), "utf8")).toBe(pid);
    expect(await (await fetch(first.json().url)).text()).toBe("game");
    const restart = await app.inject({ method: "POST", url: `/projects/${project.id}/preview` });
    expect(restart.statusCode, restart.body).toBe(200);
    expect(await readFile(path.join(project.workspacePath, "server.pid"), "utf8")).not.toBe(pid);
  });

  it("rejects missing, non-Web Game and empty projects without starting a server", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-player-preview-"));
    const app = createApp({ dataDirectory });
    cleanups.push(async () => { await app.close(); await rm(dataDirectory, { recursive: true, force: true }); });
    const empty = (await app.inject({ method: "POST", url: "/projects", payload: {} })).json();
    const story = (await app.inject({ method: "POST", url: "/projects", payload: { type: "interactive-story" } })).json();
    const response = await app.inject({ method: "POST", url: `/projects/${empty.id}/preview?reuse=1` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("no package.json");
    expect((await app.inject({ method: "POST", url: `/projects/${story.id}/preview?reuse=1` })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/projects/missing/preview?reuse=1" })).statusCode).toBe(404);
  });
});
