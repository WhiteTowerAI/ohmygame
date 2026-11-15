import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// npm installs a CLI on Windows as a .cmd script, which Node can start only
// through cmd.exe, where arguments aren't safe. The script is short and always
// the same shape: it runs one JavaScript file with Node, or one program in the
// package. For an agent npm installed, that file is started directly instead.

/** The program and leading arguments an npm `.cmd` shim runs, or undefined for anything else. */
export function npmShimTarget(shim: string, env: Record<string, string | undefined> = process.env): { file: string; args: string[] } | undefined {
  if (!/\.cmd$/i.test(shim)) return undefined;
  let text: string;
  try {
    if (statSync(shim).size > 4096) return undefined;
    text = readFileSync(shim, "utf8");
  } catch {
    return undefined;
  }
  // `"%dp0%\node_modules\pkg\cli.js" %*`, or `"%~dp0\…"` from older npm.
  const match = /"%~?dp0%?\\([^"%]+)"\s+%\*/.exec(text);
  if (!match) return undefined;
  const directory = path.dirname(shim);
  const target = path.resolve(directory, ...match[1]!.split("\\"));
  if (!existsSync(target)) return undefined;
  if (/\.exe$/i.test(target)) return { file: target, args: [] };
  // Another interpreter, such as sh, is named in `_prog`; only Node is run.
  const programs = [...text.matchAll(/SET\s+"_prog=([^"]*)"/gi)].map((found) => found[1]!);
  if (!programs.every((program) => /(?:^|\\)node(?:\.exe)?$/i.test(program))) return undefined;
  const node = [directory, ...(env.PATH ?? env.Path ?? "").split(path.delimiter)]
    .filter(Boolean)
    .map((folder) => path.join(folder, "node.exe"))
    .find((file) => existsSync(file));
  return node ? { file: node, args: [target] } : undefined;
}

/** What to start for `binaryPath`: an npm shim's target on Windows, else the path itself. */
export function launchCommand(binaryPath: string, args: readonly string[], env: Record<string, string | undefined>): { file: string; args: string[] } {
  const target = process.platform === "win32" ? npmShimTarget(binaryPath, env) : undefined;
  return target ? { file: target.file, args: [...target.args, ...args] } : { file: binaryPath, args: [...args] };
}
