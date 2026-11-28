import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isExampleSummary, isPreparedExampleCatalog, type PreparedExample, type PreparedExampleCatalog } from "../src/shared/examples.js";
import { git, replaceDirectory } from "./runtime-directory.js";

// Prepare the complete examples for publication or a developer preview.
// Ordinary desktop builds and dev startup only use the checked-in covers.

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const bundled: unknown = JSON.parse(await readFile(path.join(repositoryRoot, "resources", "examples", "catalog.json"), "utf8"));
if (!isPreparedExampleCatalog(bundled) || bundled.version !== 2) {
  throw new Error("Invalid examples lock file");
}
const lock = bundled.source;
const output = path.join(repositoryRoot, ".runtime", "examples");

if (await isCurrentOutput(output)) {
  console.log("Reusing prepared examples");
} else {
  await prepareExamples(output);
}

async function prepareExamples(destination: string): Promise<void> {
  const runtimeDirectory = path.dirname(destination);
  await mkdir(runtimeDirectory, { recursive: true });
  const temporary = await mkdtemp(path.join(runtimeDirectory, "examples-build-"));
  const source = path.join(temporary, "source");
  const prepared = path.join(temporary, "output");
  await mkdir(prepared);
  try {
    await git(["clone", "--quiet", "--no-checkout", "--filter=blob:none", `https://github.com/${lock.repository}.git`, source]);
    await git(["-c", "core.autocrlf=false", "-C", source, "checkout", "--quiet", lock.commit]);
    const actualCommit = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
    if (actualCommit !== lock.commit) throw new Error(`Unexpected commit for ${lock.repository}: ${actualCommit}`);

    const listed = JSON.parse(await readFile(path.join(source, "catalog.json"), "utf8")) as { version?: unknown; examples?: unknown };
    if (listed.version !== 1 || !Array.isArray(listed.examples)) throw new Error("The examples repository has an invalid catalog.json");
    const examples: PreparedExample[] = [];
    for (const sourceEntry of listed.examples as Array<Record<string, unknown>>) {
      const entry = { ...sourceEntry };
      if (!isExampleSummary(entry) || typeof entry.path !== "string" || typeof entry.cover !== "string") {
        throw new Error(`Invalid catalog entry: ${JSON.stringify(entry)}`);
      }
      const exampleDirectory = resolveInside(source, entry.path);
      const coverFile = resolveInside(source, entry.cover);
      const directory = `${entry.id}/files`;
      const cover = `${entry.id}/cover${path.extname(coverFile).toLowerCase()}`;
      await cp(exampleDirectory, path.join(prepared, directory), {
        recursive: true,
        filter: (file) => !["node_modules", "dist", ".git"].includes(path.basename(file)),
      });
      await cp(coverFile, path.join(prepared, cover));
      const summary = { id: entry.id, type: entry.type, name: entry.name, description: entry.description, directory, cover };
      // A game without package.json, such as an interactive story, plays as it is from its index.html.
      if (!(await stat(path.join(exampleDirectory, "package.json")).catch(() => undefined))?.isFile()) {
        await stat(path.join(exampleDirectory, "index.html"));
        examples.push(summary);
        continue;
      }
      const play = `${entry.id}/play`;
      console.log(`Building ${entry.id}…`);
      await npm(["ci", "--no-audit", "--no-fund"], exampleDirectory);
      await npm(["run", "build"], exampleDirectory);
      await stat(path.join(exampleDirectory, "dist", "index.html"));
      await cp(path.join(exampleDirectory, "dist"), path.join(prepared, play), { recursive: true });
      examples.push({ ...summary, play });
    }
    const catalog: PreparedExampleCatalog = {
      version: 1,
      source: lock,
      examples,
    };
    if (!isPreparedExampleCatalog(catalog)) throw new Error("Generated example catalog is invalid");
    await writeFile(path.join(prepared, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
    await replaceDirectory(prepared, destination);
    console.log(`Prepared ${examples.length} example${examples.length === 1 ? "" : "s"} from ${lock.repository}@${lock.release ?? lock.commit}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function npm(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(" ")} failed in ${cwd}: ${stderr.trim().slice(-2000)}`)));
  });
}

function resolveInside(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  if (path.relative(root, resolved).startsWith("..") || path.isAbsolute(path.relative(root, resolved))) {
    throw new Error(`Catalog path escapes the repository: ${relativePath}`);
  }
  return resolved;
}

async function isCurrentOutput(directory: string): Promise<boolean> {
  try {
    const catalog: unknown = JSON.parse(await readFile(path.join(directory, "catalog.json"), "utf8"));
    if (!isPreparedExampleCatalog(catalog) || catalog.version !== 1 || !isDeepStrictEqual(catalog.source, lock)) return false;
    for (const example of catalog.examples) {
      await stat(path.join(directory, example.directory, example.play ? "package.json" : "index.html"));
      await stat(path.join(directory, example.cover));
      if (example.play) await stat(path.join(directory, example.play, "index.html"));
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}
