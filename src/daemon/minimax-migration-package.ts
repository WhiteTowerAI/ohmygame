import { mediaMigrationPackageIssue } from "./media-migration-package.js";

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

export function minimaxMigrationPackageIssue(directory: string): Promise<string | undefined> {
  return mediaMigrationPackageIssue(directory, "ohmygame/minimax", MINIMAX_MIGRATION_PACKAGES);
}
