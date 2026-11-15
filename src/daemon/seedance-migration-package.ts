import { mediaMigrationPackageIssue } from "./media-migration-package.js";

/** Reviewed npm bytes, not a preinstallation, permission grant or cutover. */
export const SEEDANCE_MIGRATION_PACKAGES = [
  {
    type: "npm",
    pluginId: "seedance-migration",
    releaseId: "seedance-0.1.0",
    id: "ohmygame/seedance",
    package: "@ohmygame/seedance",
    version: "0.1.0",
    integrity:
      "sha512-1n1nhcSTIle6B6eh4WGR5w3bPDl32Q7bMWzXsnlds/WISn3vIBdnMtojwAScyqvaJAg3zxnQjImYvl3byzC7ng==",
    digest: "b1c67aa0043348ae7b353ac252859ffd5cdd76676a1b0c7dccd20cf80cb12552",
  },
] as const;

export function seedanceMigrationPackageIssue(
  directory: string,
): Promise<string | undefined> {
  return mediaMigrationPackageIssue(
    directory,
    "ohmygame/seedance",
    SEEDANCE_MIGRATION_PACKAGES,
  );
}
