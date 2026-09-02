import path from "node:path";
import { pluginComponentKey, type PluginDetail } from "../shared/plugins.js";
import type { PluginSettingsStore } from "./plugin-settings.js";

export interface PluginSkillSource {
  list(): Promise<PluginDetail[] | { plugins: PluginDetail[] }> | PluginDetail[] | { plugins: PluginDetail[] };
  installedPath(id: string): Promise<string | undefined> | string | undefined;
}

export async function resolvePluginSkillPaths(
  sources: readonly PluginSkillSource[],
  settings: PluginSettingsStore,
): Promise<string[]> {
  const skillPaths: string[] = [];
  for (const source of sources) {
    const listed = await source.list();
    const plugins = Array.isArray(listed) ? listed : listed.plugins;
    for (const plugin of plugins) {
      const root = await source.installedPath(plugin.id);
      const resolved = settings.resolve(plugin);
      if (!root || !resolved.enabled) continue;
      for (const skill of plugin.skills) {
        if (resolved.components[pluginComponentKey("skill", skill.id)]) skillPaths.push(path.join(root, skill.id));
      }
    }
  }
  return [...new Set(skillPaths)];
}
