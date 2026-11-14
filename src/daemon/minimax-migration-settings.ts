// Read-only settings preflight shared by startup migration and inspection.
import type { Snapshot } from "./minimax-settings-snapshot.js";
import { MinimaxSettingsStore } from "./minimax-settings.js";
import { proposeMediaSettings } from "./media-settings-proposal.js";
import { inspectMediaMigration } from "./media-migration-inspection.js";

// The optional beta adapter's current contract. Recheck against the
// integrity-pinned package at activation; the release lock lives beside this file.
export const MINIMAX_MIGRATION_REGIONS = [
  {
    source: "minimax-video-cn",
    target: "plugin.ohmygame.minimax.cn",
    field: "cnApiKey",
  },
  {
    source: "minimax-video-global",
    target: "plugin.ohmygame.minimax.global",
    field: "globalApiKey",
  },
] as const;
const MODELS = ["MiniMax-H3", "MiniMax-H3-Max"];

/** Reads only settings; never loads projects or calls a vendor. */
export function inspectMinimaxMigration(dataDirectory: string) {
  return inspectMediaMigration(dataDirectory, "ohmygame/minimax", new MinimaxSettingsStore(dataDirectory),
    MINIMAX_MIGRATION_REGIONS.map((region) => ({ ...region, videoModels: MODELS })));
}

/** Preserve the existing MiniMax proposal/report contract. */
export function proposeMinimaxSettings(original: Snapshot, inspected: Awaited<ReturnType<typeof inspectMinimaxMigration>>) {
  const { changes, counts } = proposeMediaSettings(original, inspected, "minimax.json", "ohmygame/minimax",
    MINIMAX_MIGRATION_REGIONS.map((region) => ({ ...region, sourceField: region.field })));
  const { defaultImageModel: _image, ...videoCounts } = counts;
  return { changes, counts: videoCounts };
}
