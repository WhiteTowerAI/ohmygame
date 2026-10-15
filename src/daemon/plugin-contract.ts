import { createRequire } from "node:module";
import {
  PLUGIN_FORMAT_VERSION,
  isNewerPluginVersion,
  type ResolvedPluginManifest,
} from "../shared/plugins.js";

export const PLUGIN_HOST_VERSION: string = createRequire(import.meta.url)(
  "../../package.json",
).version;

/** Returns why this host cannot install the package, or undefined when it can. */
export function pluginCompatibilityIssue(
  manifest: ResolvedPluginManifest,
  hostVersion = PLUGIN_HOST_VERSION,
): string | undefined {
  const format = manifest.formatVersion ?? 1;
  if (format > PLUGIN_FORMAT_VERSION)
    return `Plugin format ${format} requires a newer OhMyGame version (supported: ${PLUGIN_FORMAT_VERSION})`;
  if (
    manifest.minimumHostVersion &&
    isNewerPluginVersion(manifest.minimumHostVersion, hostVersion)
  )
    return `Plugin requires OhMyGame ${manifest.minimumHostVersion} or newer (installed: ${hostVersion})`;
  return undefined;
}
