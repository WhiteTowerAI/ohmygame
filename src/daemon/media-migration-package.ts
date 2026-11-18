import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  PLUGIN_HOST_API_VERSION,
  pluginApiIssue,
} from "../shared/plugin-manifest.js";
import {
  indexPluginPackage,
  PLUGIN_INDEX_SCHEMA_VERSION,
} from "./plugin-index.js";
import { capabilityGrants, missingGrants } from "./project-plugins.js";

/** Only application-reviewed constants may define a migration target. */
export interface ReviewedMediaPackage {
  id: string;
  package: string;
  version: string;
  digest: string;
}

/** Read-only: never construct PluginServices, whose startup may upgrade stores. */
export async function mediaMigrationPackageIssue(
  directory: string,
  pluginId: string,
  pins: readonly ReviewedMediaPackage[],
): Promise<string | undefined> {
  try {
    const index = await readRecord(directory, "plugin-store/index.json");
    if (!index) return "plugin-not-installed";
    if (
      index.schema !== PLUGIN_INDEX_SCHEMA_VERSION ||
      index.api !== PLUGIN_HOST_API_VERSION ||
      !Array.isArray(index.entries)
    )
      return "plugin-index-needs-refresh";
    if (index.entries.some((entry) => !record(entry)))
      return "plugin-index-unreadable";
    const entries = index.entries.filter((entry) => entry.id === pluginId);
    if (!entries.length) return "plugin-not-installed";
    // Do not migrate to an older pinned package while a different version runs.
    if (entries.length !== 1) return "plugin-release-not-reviewed";
    const cached = entries[0];
    const pin = pins.find((release) => release.version === cached.version);
    if (!pin) return "plugin-release-not-reviewed";
    const root = path.join(
      directory,
      "plugin-store/packages",
      pin.id,
      pin.version,
    );
    await regularPath(directory, path.relative(directory, root), true);
    if (
      typeof cached.root !== "string" ||
      !path.isAbsolute(cached.root) ||
      (await realpath(cached.root)) !== (await realpath(root))
    )
      return "plugin-not-managed";
    const origins = await readRecord(directory, "plugin-store/origins.json");
    const origin = origins?.[`${pin.id}@${pin.version}`];
    if (
      !record(origin) ||
      origin.type !== "npm" ||
      origin.package !== pin.package ||
      origin.version !== pin.version ||
      !["npmjs", "npmmirror"].includes(String(origin.registry))
    )
      return "plugin-source-not-reviewed";
    const checked = await indexPluginPackage(root);
    if (
      !checked.ok ||
      checked.entry.digest !== pin.digest ||
      checked.entry.id !== pin.id ||
      checked.entry.version !== pin.version ||
      !checked.entry.manifest.beta ||
      pluginApiIssue(checked.entry.manifest)
    )
      return "plugin-package-mismatch";
    // The app will use cached schemas/metadata. Verify those too, not only a
    // cached digest that an edited index could keep beside different metadata.
    const expected = JSON.parse(
      JSON.stringify({ ...checked.entry, root: cached.root }),
    );
    if (!isDeepStrictEqual(cached, expected)) return "plugin-index-mismatch";
    const grants = await readRecord(directory, "plugin-store/grants.json");
    if (!grants || grants.schema !== 2 || !record(grants.plugins))
      return "plugin-grants-needs-refresh";
    const grant = grants.plugins[pin.id];
    if (!record(grant) || grant.enabled !== true || grant.everyProject !== true)
      return "plugin-not-enabled";
    if (
      !Array.isArray(grant.allowed) ||
      grant.allowed.some((item) => typeof item !== "string") ||
      missingGrants(capabilityGrants(checked.entry.manifest), grant.allowed)
        .length
    )
      return "plugin-permissions-missing";
    return undefined;
  } catch {
    // Parser and OS errors can contain arbitrary stored data. Only fixed codes
    // leave this preflight, and all files remain unchanged on refusal.
    return "plugin-files-unreadable";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function regularPath(
  directory: string,
  relative: string,
  folder = false,
): Promise<string> {
  const parts = path.normalize(relative).split(path.sep);
  let current = directory;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      (index < parts.length - 1 || folder
        ? !info.isDirectory()
        : !info.isFile() || info.nlink !== 1)
    )
      throw new Error("Invalid migration source path");
  }
  return current;
}

async function readRecord(
  directory: string,
  relative: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(await regularPath(directory, relative), "utf8"),
    );
    if (!record(value)) throw new Error("Invalid migration source record");
    return value;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}
