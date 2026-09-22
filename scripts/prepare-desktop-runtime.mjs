import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const version = "22.19.0";
const runtimes = {
  "darwin-arm64": {
    archiveName: `node-v${version}-darwin-arm64.tar.gz`,
    extractedName: `node-v${version}-darwin-arm64`,
    sha256: "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d",
  },
  "win32-x64": {
    archiveName: `node-v${version}-win-x64.zip`,
    extractedName: `node-v${version}-win-x64`,
    sha256: "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86",
  },
};
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const runtime = runtimes[target];
if (!runtime) throw new Error(`Desktop packaging is not supported on ${target}`);
const { archiveName, extractedName, sha256: expectedSha256 } = runtime;
const runtimeLayout = `${version}-${target}-minimal-1`;
const runtimeRoot = path.resolve(".runtime");
const destination = path.join(runtimeRoot, "node");
const marker = path.join(destination, ".ohmygame-node-version");

try {
  if ((await readFile(marker, "utf8")).trim() === runtimeLayout) {
    console.log(`Node.js ${version} runtime is ready`);
    await prepareDesktopConfig();
    process.exit(0);
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

await mkdir(runtimeRoot, { recursive: true });
const archive = path.join(runtimeRoot, archiveName);
const extracted = path.join(runtimeRoot, extractedName);
await rm(destination, { recursive: true, force: true });
await rm(extracted, { recursive: true, force: true });

if (!(await exists(archive)) || await sha256(archive) !== expectedSha256) {
  await rm(archive, { force: true });
  console.log(`Downloading Node.js ${version} for ${target}`);
  const response = await fetch(`https://nodejs.org/dist/v${version}/${archiveName}`);
  if (!response.ok || !response.body) throw new Error(`Could not download Node.js runtime (${response.status})`);
  await pipeline(response.body, createWriteStream(archive));
}

const actualSha256 = await sha256(archive);
if (actualSha256 !== expectedSha256) {
  await rm(archive, { force: true });
  throw new Error(`Node.js runtime checksum mismatch: ${actualSha256}`);
}

await run("tar", [archiveName.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", runtimeRoot]);
await rename(extracted, destination);
await Promise.all([
  rm(path.join(destination, "include"), { recursive: true, force: true }),
  rm(path.join(destination, "share"), { recursive: true, force: true }),
  rm(path.join(destination, "CHANGELOG.md"), { force: true }),
  rm(path.join(destination, "README.md"), { force: true }),
]);
await writeFile(marker, `${runtimeLayout}\n`, "utf8");
await prepareDesktopConfig();
console.log(`Node.js ${version} runtime is ready`);

async function prepareDesktopConfig() {
  try {
    process.loadEnvFile(path.resolve(".env.local"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const cloudApiUrl = (process.env.CLOUD_API_URL ?? process.env.PUBLISH_API_URL)?.trim();
  if (cloudApiUrl) {
    const parsed = new URL(cloudApiUrl);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("CLOUD_API_URL must be an HTTP(S) URL without credentials");
    }
  }
  await writeFile(
    path.join(runtimeRoot, "desktop-config.json"),
    `${JSON.stringify({ ...(cloudApiUrl ? { cloudApiUrl } : {}) }, null, 2)}\n`,
    "utf8",
  );
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
