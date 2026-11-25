import type { Native3DProviderId } from "../shared/model3d-presets.js";
import { mediaMigrationPackageIssue } from "./media-migration-package.js";

// compat: since beta.5.8, remove from beta.7 and 2026-12-18 once native settings migration
// and paid-task recovery no longer need the reviewed package for that provider.
export const MODEL3D_MIGRATION_PACKAGES = [
  {
    provider: "meshy",
    type: "npm",
    pluginId: "meshy-migration",
    releaseId: "meshy-0.1.2",
    id: "ohmygame/meshy",
    package: "@ohmygame/meshy",
    version: "0.1.2",
    integrity:
      "sha512-JRCWDiIreW5Vuv+138wwgWlPEevtJZ9JnxM7/U+5hLZxFTLvLmkmK4BhbIdHPDqX4U3AnnMEjeBHIom/kuY7yQ==",
    digest: "2ddf8815fcfe16bf3894a8a2f7c048b3e74445104d878566a6899319cc34fded",
  },
  {
    provider: "tripo",
    type: "npm",
    pluginId: "tripo-migration",
    releaseId: "tripo-0.1.0",
    id: "ohmygame/tripo",
    package: "@ohmygame/tripo",
    version: "0.1.0",
    integrity:
      "sha512-uoiMxSj4+H03U+8+yH3Ay/oZqFwxsAM7Sb+dcnpqlKI4vAQqbTlZfAOGQZkketWs5srZUSR8Qll0MIXu41rcKQ==",
    digest: "e3001ff309aeea526e839c53764be147c73a5081a1cc30de7b27b5ffc966fbc7",
  },
] as const;

export function model3DMigrationPackageIssue(
  directory: string,
  provider: Native3DProviderId,
): Promise<string | undefined> {
  const pins = MODEL3D_MIGRATION_PACKAGES.filter(
    (pin) => pin.provider === provider,
  );
  // Hyper3D remains in preparation; never infer approval from an installed package.
  if (!pins.length) return Promise.resolve("plugin-release-not-reviewed");
  return mediaMigrationPackageIssue(directory, `ohmygame/${provider}`, pins);
}
