// `bun run plugin:check <folder>`: checks what npm would publish from a plugin
// folder, with the page components' contracts read from their sources. Exits
// with 1 when there is an error.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFolder as checkFolderWith, checkPlugin as checkPluginWith, type PluginCheckFinding } from "../src/daemon/plugin-check.js";
import { componentManifest } from "./plugin-ui-contract.js";

export type { PluginCheckFinding };
const options = { components: componentManifest };
export const checkPlugin = (root: string): Promise<PluginCheckFinding[]> => checkPluginWith(root, options);
export const checkFolder = (folder: string): Promise<PluginCheckFinding[]> => checkFolderWith(folder, options);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2];
  if (!folder) {
    console.error("Usage: bun run plugin:check <folder>");
    process.exit(2);
  }
  const findings = await checkFolder(path.resolve(folder));
  for (const { level, file, message } of findings) console[level === "error" ? "error" : "log"](`${level}: ${file ? `${file}: ` : ""}${message}`);
  const errors = findings.filter((finding) => finding.level === "error").length;
  console.log(findings.length ? `${errors} errors, ${findings.length - errors} warnings` : "No problems found");
  if (errors) process.exit(1);
}
