import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isExampleSummary, isPreparedExampleCatalog, type PreparedExample, type PreparedExampleCatalog } from "../src/shared/examples.js";
import { git, replaceDirectory } from "./runtime-directory.js";

// Downloads the pinned commit of the examples repository and packages the
// examples its catalog lists into .runtime/examples for the daemon and the
// desktop build. Pass --require to fail when the repository is unreachable;
// otherwise a missing download only disables examples.

interface LockFile {
  version: 1;
  repository: string;
  commit: string;
  release?: string;
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const lock = JSON.parse(await readFile(path.join(repositoryRoot, "config", "examples.json"), "utf8")) as LockFile;
if (lock.version !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(lock.repository) || !/^[0-9a-f]{40}$/.test(lock.commit)) {
  throw new Error("Invalid examples lock file");
}
const required = process.argv.includes("--require");
const output = path.join(repositoryRoot, ".runtime", "examples");
const lockSha256 = createHash("sha256").update(JSON.stringify(lock)).digest("hex");

if (await isCurrentOutput(output, lockSha256)) {
  console.log("Reusing prepared examples");
} else {
  try {
    await prepareExamples(output, lockSha256);
  } catch (error) {
    if (required) throw error;
    console.warn(`Examples are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function prepareExamples(destination: string, expectedLockSha256: string): Promise<void> {
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
    for (const entry of listed.examples as Array<Record<string, unknown>>) {
      if (!isExampleSummary(entry) || typeof entry.path !== "string" || typeof entry.cover !== "string") {
        throw new Error(`Invalid catalog entry: ${JSON.stringify(entry)}`);
      }
      const exampleDirectory = resolveInside(source, entry.path);
      const coverFile = resolveInside(source, entry.cover);
      if (!(await stat(path.join(exampleDirectory, "package.json"))).isFile()) throw new Error(`${entry.id} has no package.json`);
      const directory = `${entry.id}/files`;
      const cover = `${entry.id}/cover${path.extname(coverFile).toLowerCase()}`;
      await cp(exampleDirectory, path.join(prepared, directory), {
        recursive: true,
        filter: (file) => !["node_modules", "dist", ".git"].includes(path.basename(file)),
      });
      await cp(coverFile, path.join(prepared, cover));
      examples.push({ id: entry.id, type: entry.type, name: entry.name, description: entry.description, directory, cover });
    }
    const catalog: PreparedExampleCatalog = {
      version: 1,
      source: { repository: lock.repository, commit: lock.commit, ...(lock.release ? { release: lock.release } : {}) },
      examples,
    };
    if (!isPreparedExampleCatalog(catalog)) throw new Error("Generated example catalog is invalid");
    await writeFile(path.join(prepared, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
    await writeFile(path.join(prepared, "lock.sha256"), `${expectedLockSha256}\n`);
    await replaceDirectory(prepared, destination);
    console.log(`Prepared ${examples.length} example${examples.length === 1 ? "" : "s"} from ${lock.repository}@${lock.release ?? lock.commit}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function resolveInside(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  if (path.relative(root, resolved).startsWith("..") || path.isAbsolute(path.relative(root, resolved))) {
    throw new Error(`Catalog path escapes the repository: ${relativePath}`);
  }
  return resolved;
}

async function isCurrentOutput(directory: string, expectedLockSha256: string): Promise<boolean> {
  try {
    if ((await readFile(path.join(directory, "lock.sha256"), "utf8")).trim() !== expectedLockSha256) return false;
    const catalog: unknown = JSON.parse(await readFile(path.join(directory, "catalog.json"), "utf8"));
    if (!isPreparedExampleCatalog(catalog)) return false;
    for (const example of catalog.examples) {
      await stat(path.join(directory, example.directory, "package.json"));
      await stat(path.join(directory, example.cover));
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}
