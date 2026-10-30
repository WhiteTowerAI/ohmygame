import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractFile } from "@electron/asar";
import { startDaemon } from "../dist/desktop/daemon-process.js";
import { checkStoryWeb } from "./check-story-web.mjs";
import { isolateDesktopArchive } from "./isolated-desktop-archive.mjs";

// Run against the assembled app, before creating installers or publishing it.
export default async function checkPackagedDesktop(context) {
  const { packager, appOutDir, electronPlatformName } = context;
  const resources = packager.getResourcesDir(appOutDir);
  const archive = path.join(resources, "app.asar");
  const appDirectory = packager.info.appDir;
  const metadata = JSON.parse(await readFile(path.join(appDirectory, "package.json"), "utf8"));
  const storyResources = path.join("dist", "story-web", "resources.json");
  assert(
    extractFile(archive, storyResources).equals(await readFile(path.join(appDirectory, storyResources))),
    "Packaged story resources must match the build",
  );
  const piVersion = metadata.dependencies["@earendil-works/pi-ai"];
  const patch = await readFile(path.join(appDirectory, metadata.patchedDependencies[`@earendil-works/pi-ai@${piVersion}`]), "utf8");
  const patchedFiles = [...patch.matchAll(/^diff --git .* b\/(\S+\.js)$/gm)].map(match => match[1]);
  assert(patchedFiles.includes("dist/utils/provider-failure.js"), "Pi patch must include the provider failure helper");
  for (const file of patchedFiles) {
    const entry = path.join("node_modules", "@earendil-works", "pi-ai", file);
    const expected = await readFile(path.join(appDirectory, entry));
    assert(extractFile(archive, entry).equals(expected), `Packaged Pi patch differs from the installed dependency: ${file}`);
  }

  if (electronPlatformName !== process.platform) {
    console.log("Packaged Pi patch and story resources verified; daemon startup requires the target platform.");
    return;
  }
  const name = packager.appInfo.productFilename;
  const executable = electronPlatformName === "darwin"
    ? path.join(resources, "..", "MacOS", name)
    : path.join(appOutDir, electronPlatformName === "win32" ? `${name}.exe` : packager.executableName);
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-packaged-runtime-"));
  // Keep developer credentials and local app data out of the package check.
  const environment = Object.fromEntries(
    ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]
      .filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]]),
  );
  let daemon;
  try {
    // Starting under release/ can silently load a missing production dependency
    // from the checkout's node_modules. Resolve all app modules from a copy
    // outside the checkout, including native files kept beside the archive.
    const isolatedArchive = await isolateDesktopArchive(archive, directory);
    daemon = await startDaemon({
      executable,
      daemonEntry: path.join(isolatedArchive, "dist", "daemon", "server.js"),
      dataDirectory: path.join(directory, "data"),
      piAgentDirectory: path.join(directory, "pi-agent"),
      token: "packaged-runtime-check",
      allowedOrigins: [],
      environment,
      runtimeBin: path.join(resources, "runtime", "node", ...(electronPlatformName === "win32" ? [] : ["bin"])),
      bundledPluginsDirectory: path.join(resources, "plugins"),
      preinstalledPluginsDirectory: path.join(resources, "preinstalled-plugins"),
      examplesDirectory: path.join(resources, "examples"),
      healthTimeoutMs: 30_000,
    });
    const unauthorized = await fetch(`${daemon.runtime.url}/projects`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(unauthorized.status, 401, "Packaged daemon must require authentication");
    const response = await fetch(`${daemon.runtime.url}/projects`, {
      headers: { authorization: `Bearer ${daemon.runtime.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, "Packaged daemon must serve the projects API");
    assert.deepEqual(await response.json(), [], "Package check must use an empty isolated workspace");
    await access(path.join(resources, "integrations", "skills", "ohmygame-studio", "SKILL.md"));
    const handshake = await externalMcpHandshake(executable, path.join(isolatedArchive, "dist", "desktop", "external-mcp-main.js"), path.join(directory, "data"), environment);
    assert.equal(handshake.result?.serverInfo?.name, "ohmygame-studio", "Packaged MCP launcher must answer from the app archive");
    await checkStoryWeb(daemon.runtime);
    console.log("Packaged Pi patch, daemon startup, authenticated API, MCP launcher and story creation, upgrade and preview passed.");
  } finally {
    await daemon?.stop();
    // Windows can retain the executable image lock briefly after the process
    // closes. electron-builder edits this executable as soon as afterPack
    // returns, so give the loader time to release it first.
    if (electronPlatformName === "win32") {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    await rm(directory, { recursive: true, force: true });
  }
}

/** Runs the launcher the way Claude Code and Codex do and reads its answer to `initialize`. */
function externalMcpHandshake(executable, entry, dataDirectory, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [entry, "--data-dir", dataDirectory], {
      env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("The MCP launcher did not answer")); }, 15_000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((item) => item.trim());
      if (!line || !output.includes("\n")) return;
      clearTimeout(timer);
      child.stdin.end();
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })}\n`);
  });
}
