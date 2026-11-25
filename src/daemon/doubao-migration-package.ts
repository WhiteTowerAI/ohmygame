import { mediaMigrationPackageIssue } from "./media-migration-package.js";

/** Reviewed release bytes, not a preinstallation, permission grant or cutover. */
export const DOUBAO_MIGRATION_PACKAGES = [
  {
    type: "release",
    pluginId: "doubao-voice-migration",
    releaseId: "doubao-voice-0.1.1",
    id: "ohmygame/doubao-voice",
    package: "@ohmygame/doubao-voice",
    version: "0.1.1",
    url: "https://github.com/WhiteTowerAI/ohmygame-plugins/releases/download/doubao-voice-v0.1.1/doubao-voice-0.1.1.zip",
    size: 16673,
    sha256: "cdedf9a62d7a6d72fcaf4257eee489fecea4ba07a1242bc5e0ae4a443f31e533",
    digest: "02f76695f5a57428646d7a88baec914c1f41ebc1028c3b17de3c2c1bbde9c412",
  },
] as const;

export function doubaoMigrationPackageIssue(
  directory: string,
): Promise<string | undefined> {
  return mediaMigrationPackageIssue(
    directory,
    "ohmygame/doubao-voice",
    DOUBAO_MIGRATION_PACKAGES,
  );
}
