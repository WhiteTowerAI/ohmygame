import type { Native3DProviderId } from "../shared/model3d-presets.js";
import { checkMediaMigrationPackage } from "./media-migration-package.js";

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
    type: "release",
    pluginId: "tripo-migration",
    releaseId: "tripo-0.1.1",
    id: "ohmygame/tripo",
    package: "@ohmygame/tripo",
    version: "0.1.1",
    url: "https://github.com/WhiteTowerAI/ohmygame-plugins/releases/download/tripo-v0.1.1/tripo-0.1.1.zip",
    size: 14837,
    sha256: "f648b59c019638e25fb248e1a18d715510f1b482f815feb1487092d4aaa7620d",
    digest: "cc24bc90db4487f324bf1a807858ca06a5a71ec89231addd0cd6c2f527f0edee",
  },
  // compat: retain through two release series and 30 days after the first desktop
  // release with Hyper3D cutover, and while old settings or paid tasks need it.
  {
    provider: "hyper3d",
    type: "release",
    pluginId: "hyper3d-migration",
    releaseId: "hyper3d-0.1.0",
    id: "ohmygame/hyper3d",
    package: "@ohmygame/hyper3d",
    version: "0.1.0",
    url: "https://github.com/WhiteTowerAI/ohmygame-plugins/releases/download/hyper3d-v0.1.0/hyper3d-0.1.0.zip",
    size: 10707,
    sha256: "5ec6330244ddf48ece458d294c2024b70f7ffd3d0b8a9842ff5923434f410635",
    digest: "7a853d98314c8aff350ca9e20b83fb5486655f4ea7b4a38fa8e4da628f2c22af",
  },
] as const;

export function checkModel3DMigrationPackage(
  directory: string,
  provider: Native3DProviderId,
) {
  const pins = MODEL3D_MIGRATION_PACKAGES.filter(
    (pin) => pin.provider === provider,
  );
  return checkMediaMigrationPackage(directory, `ohmygame/${provider}`, pins);
}
