import { createRequire } from "node:module";
import {
  PLUGIN_FORMAT_VERSION,
  isNewerPluginVersion,
  type ResolvedPluginManifest,
} from "../shared/plugins.js";

export const PLUGIN_HOST_VERSION: string = createRequire(import.meta.url)(
  "../../package.json",
).version;

export function assertPluginCompatibility(
  manifest: ResolvedPluginManifest,
  hostVersion = PLUGIN_HOST_VERSION,
): void {
  const format = manifest.formatVersion ?? 1;
  if (format > PLUGIN_FORMAT_VERSION)
    throw new Error(
      `Plugin format ${format} requires a newer OhMyGame version (supported: ${PLUGIN_FORMAT_VERSION})`,
    );
  if (
    manifest.minimumHostVersion &&
    isNewerPluginVersion(manifest.minimumHostVersion, hostVersion)
  )
    throw new Error(
      `Plugin requires OhMyGame ${manifest.minimumHostVersion} or newer (installed: ${hostVersion})`,
    );
}
