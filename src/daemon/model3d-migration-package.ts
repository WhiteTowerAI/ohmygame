import type { Native3DProviderId } from "../shared/model3d-presets.js";
import { checkMediaMigrationPackage } from "./media-migration-package.js";

/** Reviewed packages, newest first per provider for the offline rehearsal. */
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
    provider: "meshy",
    type: "npm",
    pluginId: "meshy-migration",
    releaseId: "meshy-0.1.1",
    id: "ohmygame/meshy",
    package: "@ohmygame/meshy",
    version: "0.1.1",
    integrity:
      "sha512-D3c/Sj9q478TvWhqGyaY07ieG6Tr+ld9bFUqJG3qcBpigyCGfhAve8qc+7RSVAERDfQc7QjibWUvVyO4jFofLA==",
    digest: "c84de1a7508b3d9c2c9ea1d5996013ae18b09f5dfadd34f820b58a443f9e93d4",
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

export type Model3DMigrationPackage = (typeof MODEL3D_MIGRATION_PACKAGES)[number];

export function checkModel3DMigrationPackage(
  directory: string,
  provider: Native3DProviderId,
) {
  const pins = MODEL3D_MIGRATION_PACKAGES.filter(
    (pin) => pin.provider === provider,
  );
  // Hyper3D remains in preparation; never infer approval from an installed package.
  return checkMediaMigrationPackage(directory, `ohmygame/${provider}`, pins);
}

export async function model3DMigrationPackageIssue(directory: string, provider: Native3DProviderId) {
  const result = await checkModel3DMigrationPackage(directory, provider);
  return typeof result === "string" ? result : undefined;
}
