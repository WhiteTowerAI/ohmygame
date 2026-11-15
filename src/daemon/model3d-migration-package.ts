import type { Native3DProviderId } from "../shared/model3d-presets.js";
import { mediaMigrationPackageIssue } from "./media-migration-package.js";

/** Reviewed Beta npm bytes. No installation, settings writes or native cutover. */
export const MODEL3D_MIGRATION_PACKAGES = [
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
