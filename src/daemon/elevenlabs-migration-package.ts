import { mediaMigrationPackageIssue } from "./media-migration-package.js";

/** Reviewed npm bytes, not a preinstallation, permission grant or cutover. */
export const ELEVENLABS_MIGRATION_PACKAGES = [
  {
    type: "npm",
    pluginId: "elevenlabs-migration",
    releaseId: "elevenlabs-0.1.0",
    id: "ohmygame/elevenlabs",
    package: "@ohmygame/elevenlabs",
    version: "0.1.0",
    integrity:
      "sha512-cqILNLsdoL+tWxxgjhLPuqVusbkik/jZPkvqD1AzKCTgEdyRVRgmycH/9i5mcSbNwG6URa1PiN8aotlAVxsc3A==",
    digest: "9d88442d31429a4f8e05b86d1cd85b3c60de578a5e050361fbe30a092b4fa7b0",
  },
] as const;

export function elevenlabsMigrationPackageIssue(
  directory: string,
): Promise<string | undefined> {
  return mediaMigrationPackageIssue(
    directory,
    "ohmygame/elevenlabs",
    ELEVENLABS_MIGRATION_PACKAGES,
  );
}
