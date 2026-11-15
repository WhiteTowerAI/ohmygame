import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ProjectState } from "../src/shared/contracts.js";

const fixtures: { app: ReturnType<typeof createApp>; directories: string[] }[] = [];
afterEach(async () => {
  for (const { app, directories } of fixtures.splice(0)) {
    await app.close();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
});

// A GitHub Pages publisher: its command gets the game's web build and pushes
// it to the gh-pages branch of the remote in its settings.
const PAGES = `
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
export function activate(context) {
  context.registerCommand("publish", async (_input, { build, configuration, progress }) => {
    if (!build) throw new Error("No web build");
    const files = await readdir(build.folder, { recursive: true });
    const work = await mkdtemp(path.join(tmpdir(), "pages-"));
    try {
      await cp(build.folder, work, { recursive: true });
      const git = (...args) => execFileSync("git", args, { cwd: work, stdio: "pipe" });
      git("init", "-q", "-b", "gh-pages");
      git("add", "-A");
      git("-c", "user.name=Pages", "-c", "user.email=pages@example.com", "commit", "-q", "-m", "Publish");
      progress("Pushing to GitHub Pages");
      git("push", "-q", "--force", configuration.remote, "gh-pages");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    return { folder: build.folder, files: files.map((file) => file.split(path.sep).join("/")).sort() };
  });
  // An upload that lasts until the test lets it end.
  context.registerCommand("upload", async (_input, { configuration }) => {
    await writeFile(path.join(configuration.remote, "uploading"), "");
    while (!existsSync(path.join(configuration.remote, "uploaded"))) await new Promise((resolve) => setTimeout(resolve, 10));
    return true;
  });
}
`;

/** A project using the GitHub Pages publisher, pushing to a local bare repository. */
async function setup(type?: string) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-publish-"));
  const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-publish-source-"));
  const remote = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-publish-remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const app = createApp({ dataDirectory });
  fixtures.push({ app, directories: [dataDirectory, source, remote] });
  await app.ready();
  await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
  await writeFile(path.join(source, "index.mjs"), PAGES);
  await writeFile(path.join(source, ".ohmygame-plugin/plugin.json"), JSON.stringify({
    id: "acme/pages", version: "1.0.0", engines: { "ohmygame-api": "^2.3.0" }, displayName: "Pages", description: "Publishes to GitHub Pages.",
    entrypoints: { native: "./index.mjs" },
    capabilities: { native: true, processes: ["git"] },
    configuration: { remote: { type: "text", title: "Remote" } },
    contributes: {
      commands: [
        { id: "publish", title: "GitHub Pages", run: { native: "publish", build: "web", changesFiles: false }, slots: [{ slot: "project.publish" }] },
        { id: "upload", title: "Upload", run: { native: "upload", build: "web", changesFiles: false } },
      ],
    },
  }));
  const payload = { source: { type: "directory", path: source } };
  const inspected = await app.inject({ method: "POST", url: "/plugin-sources/inspect", payload });
  expect(inspected.statusCode, inspected.body).toBe(200);
  const added = await app.inject({ method: "POST", url: "/plugin-sources/install", payload: { ...payload, digest: inspected.json().digest } });
  expect(added.statusCode, added.body).toBe(201);
  expect((await app.inject({ method: "PUT", url: "/plugin-store/acme/pages/configuration", payload: { remote } })).statusCode).toBe(200);
  const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Pages", ...(type ? { type } : {}) } })).json<ProjectState>();
  const on = await app.inject({ method: "PUT", url: `/projects/${project.id}/plugins/acme/pages`, payload: { on: true, version: "1.0.0" } });
  expect(on.statusCode, on.body).toBe(204);
  const publish = () => app.inject({ method: "POST", url: `/projects/${project.id}/plugin-commands`, payload: { command: "acme/pages:publish" } });
  return { app, project, remote, publish };
}

describe("plugin publishing", () => {
  it("gives a publish command the game's web build, and removes it afterwards", async () => {
    const { app, project, remote, publish } = await setup();
    await writeFile(path.join(project.workspacePath, "index.html"), "<h1>Game</h1>");
    await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "assets/hero.png"), "png");
    const listed = (await app.inject({ method: "GET", url: `/projects/${project.id}/plugin-commands` })).json();
    expect(listed).toContainEqual(expect.objectContaining({ id: "acme/pages:publish", slots: [{ slot: "project.publish" }], run: expect.objectContaining({ build: "web" }) }));

    const published = await publish();
    expect(published.statusCode, published.body).toBe(200);
    const { folder, files } = published.json().result as { folder: string; files: string[] };
    // The build is what Export web build makes: no hidden files, and not the agent's instructions.
    expect(files).toEqual(expect.arrayContaining(["assets/hero.png", "index.html"]));
    expect(files.filter((file) => file.startsWith(".") || file === "AGENTS.md")).toEqual([]);
    expect(execFileSync("git", ["--git-dir", remote, "show", "gh-pages:index.html"], { encoding: "utf8" })).toBe("<h1>Game</h1>");
    await expect(import("node:fs/promises").then(({ access }) => access(folder))).rejects.toThrow();
  });

  it("leaves exporting free while a plugin uploads its finished build", async () => {
    const { app, project, remote } = await setup();
    await writeFile(path.join(project.workspacePath, "index.html"), "<h1>Game</h1>");
    const uploading = app.inject({ method: "POST", url: `/projects/${project.id}/plugin-commands`, payload: { command: "acme/pages:upload" } });
    await expect.poll(() => existsSync(path.join(remote, "uploading")), { timeout: 10_000 }).toBe(true);
    const exported = await app.inject({ method: "POST", url: `/projects/${project.id}/build` });
    await writeFile(path.join(remote, "uploaded"), "");
    expect(exported.statusCode, exported.body).toBe(200);
    expect((await uploading).statusCode).toBe(200);
  });

  it("refuses to build a project that has no web build", async () => {
    const { publish } = await setup("asset-canvas");
    const refused = await publish();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("Build requires");
  });
});
