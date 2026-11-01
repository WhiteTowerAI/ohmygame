// Moves what the format 1 Unreal Engine plugin kept to the format 2 plugin,
// which replaced it: its app switch and its endpoint setting. Format 1 was on
// in every General project once turned on; format 2 is turned on per project,
// so the person still chooses the projects.
import type { PluginConfigurationStore } from "./plugin-configuration.js";
import type { PluginServices } from "./plugin-services.js";
import { capabilityGrants } from "./project-plugins.js";

export const LEGACY_UNREAL_ID = "ohmygame:unreal-engine";
export const UNREAL_PLUGIN = "ohmygame/unreal-engine";

export interface LegacyUnrealMigration {
  configuration: Pick<PluginConfigurationStore, "storedValues" | "remove">;
  services: Pick<PluginServices, "ready" | "index" | "grants" | "values" | "changed">;
  /** The format 1 switch the person set, if they ever did. */
  legacyEnabled: boolean | undefined;
  warn: (message: string, error?: unknown) => void;
}

/**
 * Turns format 2 Unreal on, with consent, when the person had turned format 1
 * on and hasn't decided about format 2 yet; and sets its `endpoint` from
 * format 1's, unless the person already set it, then forgets the format 1
 * values so a later change sticks. An endpoint format 2 can't use (not on
 * this computer) isn't moved; the warning names it.
 */
export async function migrateLegacyUnreal(options: LegacyUnrealMigration): Promise<void> {
  const stored = options.configuration.storedValues(LEGACY_UNREAL_ID);
  if (options.legacyEnabled !== true && !stored) return;
  const { services } = options;
  await services.ready();
  const entry = services.index.get(UNREAL_PLUGIN);
  if (!entry) return options.warn("The bundled Unreal Engine plugin is missing; its settings move at the next start");
  // Starting off records only the switch; a decision of the person's records consent too.
  const decided = services.grants.plugin(UNREAL_PLUGIN);
  if (options.legacyEnabled === true && (!decided || (!decided.enabled && !decided.allowed.length))) {
    await services.grants.setEnabled(UNREAL_PLUGIN, true);
    await services.grants.consent(UNREAL_PLUGIN, capabilityGrants(entry.manifest));
    await services.changed();
  }
  if (!stored) return;
  const endpoint = typeof stored.endpoint === "string" ? stored.endpoint.trim() : "";
  const field = entry.manifest.configuration?.endpoint;
  if (endpoint && endpoint !== field?.default && !services.values.isSet(entry, "endpoint")) {
    try {
      await services.values.update(entry, { endpoint });
      await services.changed();
    } catch (error) {
      options.warn(`Unreal Engine's endpoint ${endpoint} can't move to the format 2 plugin; set it on the plugin's page`, error);
    }
  }
  await options.configuration.remove(LEGACY_UNREAL_ID);
}
