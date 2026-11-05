// `ohmygame-plugin`: checks a plugin package the way OhMyGame checks one it
// adds, with the app's own code, before anyone installs it.
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkFolder, checkPlugin, type PluginCheckFinding, type PluginCheckOptions, type PluginComponentContract } from "../../../src/daemon/plugin-check.js";
import { indexPluginPackage } from "../../../src/daemon/plugin-index.js";
import { unpackPlugin } from "../../../src/daemon/plugin-pack.js";
import { PLUGIN_HOST_API_VERSION } from "../../../src/shared/plugin-manifest.js";

const USAGE = `Usage: ohmygame-plugin <command> [folder]

Commands:
  check [folder]   Checks what npm would publish from the folder
  pack [folder]    Packs the folder with npm, checks the package and keeps
                   the .tgz only when it has no errors

Options:
  --pack-destination <folder>  Where pack puts the .tgz; the folder by default
  -v, --version                The plugin API this checks for
  -h, --help`;

const here = path.dirname(fileURLToPath(import.meta.url));
/** The page components' contracts ship beside the CLI, as the app serves them. */
const options: PluginCheckOptions = {
  components: async (major) => JSON.parse(await readFile(path.join(here, "ui", major, "custom-elements.json"), "utf8")) as PluginComponentContract,
};

function report(findings: PluginCheckFinding[]): number {
  for (const { level, file, message } of findings) console[level === "error" ? "error" : "log"](`${level}: ${file ? `${file}: ` : ""}${message}`);
  const errors = findings.filter((finding) => finding.level === "error").length;
  console.log(findings.length ? `${errors} errors, ${findings.length - errors} warnings` : "No problems found");
  return errors;
}

/** Runs `npm pack` in the folder and returns the archive it made in `into`. */
function npmPack(folder: string, into: string): string {
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", into], {
    cwd: folder,
    encoding: "utf8",
    // npm is npm.cmd on Windows, which only a shell runs; the arguments are ours.
    shell: process.platform === "win32",
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.error) throw new Error(`Could not run npm: ${result.error.message}. pack needs npm.`);
  if (result.status !== 0) throw new Error("npm pack failed");
  // Scripts such as prepack may print before npm's JSON, which starts a line.
  const start = result.stdout.search(/^\[/m);
  const packed = start < 0 ? undefined : (JSON.parse(result.stdout.slice(start)) as { filename?: unknown }[])[0]?.filename;
  if (typeof packed !== "string") throw new Error("npm pack didn't say what it made");
  return path.join(into, path.basename(packed));
}

async function pack(folder: string, destination: string): Promise<number> {
  const work = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-pack-"));
  try {
    const archive = npmPack(folder, work);
    const root = await unpackPlugin(archive, work, { published: true, error: (reason) => new Error(`npm's package can't be unpacked (${reason})`) });
    const errors = report(await checkPlugin(root, options));
    if (errors) {
      console.error(`Not packed: fix the errors, then pack again.`);
      return 1;
    }
    const checked = await indexPluginPackage(root);
    const target = path.join(destination, path.basename(archive));
    await copyFile(archive, target);
    if (checked.ok) console.log(`Packed ${checked.entry.id} ${checked.entry.version} as ${target}\nPackage digest ${checked.entry.digest}`);
    return 0;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "pack-destination": { type: "string" }, version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" } },
  });
  if (values.version) {
    console.log(`Plugin API ${PLUGIN_HOST_API_VERSION}`);
    return 0;
  }
  const [command, target = ".", ...rest] = positionals;
  if (values.help || !command || rest.length) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const folder = path.resolve(target);
  if (command === "check") return report(await checkFolder(folder, options)) ? 1 : 0;
  if (command === "pack") return pack(folder, path.resolve(values["pack-destination"] ?? folder));
  console.error(`There is no command ${command}.\n\n${USAGE}`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  },
);
