import type { PluginMention } from "../shared/contracts.js";
import { Package, WandSparkles } from "./icons.js";
import { skillDisplayName } from "./composer-mentions.js";
import { GodotIcon } from "./godot-icon.js";

export function ComposerCapabilityReferences({ skill, plugin, onRemoveSkill, onRemovePlugin }: {
  skill?: string;
  plugin?: PluginMention;
  onRemoveSkill: () => void;
  onRemovePlugin: () => void;
}) {
  if (!skill && !plugin) return null;
  return <div className="composer-capability-references">
    {skill ? <button
      className="composer-capability-reference"
      type="button"
      title="Remove skill"
      aria-label={`Remove ${skillDisplayName(skill)} skill`}
      onClick={onRemoveSkill}
    >
      <WandSparkles size={15} aria-hidden="true" />
      <span>{skillDisplayName(skill)}</span>
    </button> : null}
    {plugin ? <button
      className="composer-capability-reference"
      type="button"
      title="Remove plugin"
      aria-label={`Remove ${plugin.displayName} plugin`}
      onClick={onRemovePlugin}
    >
      {isGodotPlugin(plugin) ? <GodotIcon size={15} /> : <Package size={15} aria-hidden="true" />}
      <span>{plugin.displayName}</span>
    </button> : null}
  </div>;
}

function isGodotPlugin(plugin: Pick<PluginMention, "name" | "marketplaceId">): boolean {
  return plugin.marketplaceId === "ohmygame" && plugin.name === "godot";
}
