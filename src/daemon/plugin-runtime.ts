import path from "node:path";
import { pluginComponentKey, type ConfigurablePluginComponentType, type PluginComponentSummary, type PluginDetail } from "../shared/plugins.js";
import type { LocalPluginStore } from "./local-plugins.js";
import type { PluginSettingsStore } from "./plugin-settings.js";

export async function resolvePluginSkillPaths(
  localPlugins: LocalPluginStore,
  settings: PluginSettingsStore,
): Promise<string[]> {
  const skillPaths: string[] = [];
  const local = await localPlugins.list();
  for (const plugin of local.plugins) {
    const root = await localPlugins.installedPath(plugin.id);
    const resolved = settings.resolve(plugin);
    if (!root || !resolved.enabled) continue;
    addEnabled(skillPaths, root, "skill", plugin.skills, resolved.components);
  }
  return [...new Set(skillPaths)];
}

export function enabledComponentIds(
  plugins: readonly PluginDetail[],
  settings: PluginSettingsStore,
  type: ConfigurablePluginComponentType,
): Set<string> {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    const resolved = settings.resolve(plugin);
    if (!resolved.enabled) continue;
    const components = type === "tool" ? plugin.tools : type === "skill" ? plugin.skills : plugin.connections;
    for (const component of components) {
      if (resolved.components[pluginComponentKey(type, component.id)]) ids.add(component.id);
    }
  }
  return ids;
}

function addEnabled(
  target: string[],
  root: string,
  type: ConfigurablePluginComponentType,
  components: PluginComponentSummary[],
  settings: Record<string, boolean>,
): void {
  for (const component of components) {
    if (settings[pluginComponentKey(type, component.id)]) target.push(path.join(root, component.id));
  }
}
