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

/** Reviewed npm bytes, not a preinstallation or permission grant. */
export const MINIMAX_MIGRATION_PACKAGES = [{
  type: "npm",
  pluginId: "minimax-migration",
  releaseId: "minimax-0.1.0",
  id: "ohmygame/minimax",
  package: "@ohmygame/minimax",
  version: "0.1.0",
  integrity:
    "sha512-Haq/K2D644uG1kTVX4ncU+hmDLPkeSq4IYRy0E86IICORoqLv6Ut15tq3ZOyjbqUPTFUCY6ZGHwMHzkX75eHOQ==",
  digest: "79dd1d119f829242a995ef37b9060ced2355b839f1c748264d441612836bb240",
}, {
  type: "npm",
  pluginId: "minimax-migration",
  releaseId: "minimax-0.1.1",
  id: "ohmygame/minimax",
  package: "@ohmygame/minimax",
  version: "0.1.1",
  integrity:
    "sha512-d5LTSqE4i8RvYr3XmejUAdZKUxV/ZvJwTCMeSozO1T7t7Y+KXyJ06aNDRR6ac/sqyD2NxtFfa/3C6qJrMmV9Mw==",
  digest: "ec4e1b30f65d29d56d5b7914b84670028b58e7ca269d48b309c42a507893f966",
}, {
  type: "npm",
  pluginId: "minimax-migration",
  releaseId: "minimax-0.1.2",
  id: "ohmygame/minimax",
  package: "@ohmygame/minimax",
  version: "0.1.2",
  integrity:
    "sha512-HMeXndwX90Zr5y8bEuWiGkws8uokTkOe6diGWvye1V3l1lY2mSevrZIc1qUpI4z/izcdizeQAng+OUq2hjrR3A==",
  digest: "53a63277d50df1babe4ab2b70d2fb5633238d342eb107c9651e5a94122c6adcb",
}] as const;

/** Read-only: never construct PluginServices, whose startup may upgrade stores. */
export async function minimaxMigrationPackageIssue(
  directory: string,
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
    const entries = index.entries.filter((entry) => entry.id === "ohmygame/minimax");
    if (!entries.length) return "plugin-not-installed";
    // Do not migrate to an older pinned package while a different version runs.
    if (entries.length !== 1) return "plugin-release-not-reviewed";
    const cached = entries[0];
    const pin = MINIMAX_MIGRATION_PACKAGES.find((release) => release.version === cached.version);
    if (!pin) return "plugin-release-not-reviewed";
    const root = path.join(
      directory,
      "plugin-store/packages/ohmygame/minimax",
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
