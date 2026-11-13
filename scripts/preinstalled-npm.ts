import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { indexPluginPackage } from "../src/daemon/plugin-index.js";
import { unpackPlugin } from "../src/daemon/plugin-pack.js";
import { downloadRelease } from "../src/daemon/plugin-releases.js";
import {
  isPluginVersion,
  npmPackagePluginIds,
  PLUGIN_ARCHIVE_MAX_BYTES,
} from "../src/shared/plugins.js";

/** Build-time source, committed only after the exact npm release is published. */
export interface LockedNpmPlugin {
  type: "npm";
  pluginId: string;
  releaseId: string;
  id: string;
  package: string;
  version: string;
  integrity: string;
}

export function isLockedNpmPlugin(value: unknown): value is LockedNpmPlugin {
  if (!value || typeof value !== "object") return false;
  const entry = value as LockedNpmPlugin;
  return (
    entry.type === "npm" &&
    [entry.pluginId, entry.releaseId].every(
      (id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id),
    ) &&
    typeof entry.package === "string" &&
    entry.package.startsWith("@ohmygame/") &&
    Boolean(npmPackagePluginIds(entry.package)?.includes(entry.id)) &&
    isPluginVersion(entry.version) &&
    typeof entry.integrity === "string" &&
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)
  );
}

/** No registry metadata or lifecycle scripts: the reviewed lock is authoritative. */
export async function prepareNpmPlugin(
  entry: LockedNpmPlugin,
  directory: string,
  download = downloadRelease,
): Promise<Buffer> {
  if (!isLockedNpmPlugin(entry)) throw new Error("Invalid pinned npm plugin");
  const name = entry.package.split("/")[1]!;
  const file = path.join(directory, "package.tgz");
  await download(
    `https://registry.npmjs.org/${entry.package}/-/${name}-${entry.version}.tgz`,
    file,
    PLUGIN_ARCHIVE_MAX_BYTES,
    AbortSignal.timeout(300_000),
  );
  const bytes = await readFile(file);
  if (
    bytes.length > PLUGIN_ARCHIVE_MAX_BYTES ||
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !==
      entry.integrity
  )
    throw new Error(
      `${entry.package} ${entry.version} failed integrity verification`,
    );
  const root = await unpackPlugin(file, directory, {
    published: true,
    error: (reason) => new Error(`Invalid npm plugin archive: ${reason}`),
  });
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (pkg.name !== entry.package || pkg.version !== entry.version)
    throw new Error("Npm package identity does not match the lock");
  if (
    ["preinstall", "install", "postinstall"].some((name) => pkg.scripts?.[name])
  )
    throw new Error(
      "Preinstalled plugins cannot require npm installation scripts",
    );
  const checked = await indexPluginPackage(root);
  if (!checked.ok)
    throw new Error(
      `Invalid preinstalled plugin: ${checked.issues.map((issue) => issue.message).join("; ")}`,
    );
  if (checked.entry.id !== entry.id || checked.entry.version !== entry.version)
    throw new Error("Plugin identity does not match the lock");
  // Keep the exact npm bytes: the older ZIP packer filters dotfiles and dependencies.
  return bytes;
}
