import { mediaMigrationPackageIssue } from "./media-migration-package.js";

/** Reviewed npm bytes, not a preinstallation, permission grant or cutover. */
export const DOUBAO_MIGRATION_PACKAGES = [
  {
    type: "npm",
    pluginId: "doubao-voice-migration",
    releaseId: "doubao-voice-0.1.0",
    id: "ohmygame/doubao-voice",
    package: "@ohmygame/doubao-voice",
    version: "0.1.0",
    integrity:
      "sha512-F7r9SUMHnoS7w3sUzlVmIhQqVwxc+HtWLBUTBWUtzm73exAsoRO94E9odYU1djgQ3zmGXnpQhkevi+10jgYApw==",
    digest: "5a33e8195e85f2e1e3b33314f7fa9cec9cba6ce26b99705b0f313e31dd2b9a6f",
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
