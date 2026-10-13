import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractFile } from "@electron/asar";
import { startDaemon } from "../dist/desktop/daemon-process.js";

// Run against the assembled app, before creating installers or publishing it.
export default async function checkPackagedDesktop(context) {
  const { packager, appOutDir, electronPlatformName } = context;
  const resources = packager.getResourcesDir(appOutDir);
  const archive = path.join(resources, "app.asar");
  const appDirectory = packager.info.appDir;
  const metadata = JSON.parse(await readFile(path.join(appDirectory, "package.json"), "utf8"));
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
    console.log("Packaged Pi patch verified; daemon startup requires the target platform.");
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
    daemon = await startDaemon({
      executable,
      daemonEntry: path.join(archive, "dist", "daemon", "server.js"),
      dataDirectory: path.join(directory, "data"),
      piAgentDirectory: path.join(directory, "pi-agent"),
      token: "packaged-runtime-check",
      allowedOrigins: [],
      environment,
      runtimeBin: path.join(resources, "runtime", "node", ...(electronPlatformName === "win32" ? [] : ["bin"])),
      bundledPluginsDirectory: path.join(resources, "plugins"),
      preinstalledPluginsDirectory: path.join(resources, "preinstalled-plugins"),
      examplesDirectory: path.join(resources, "examples"),
      playerDirectory: path.join(resources, "app.asar.unpacked", "dist", "player"),
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
    console.log("Packaged Pi patch, daemon startup and authenticated API passed.");
  } finally {
    await daemon?.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
