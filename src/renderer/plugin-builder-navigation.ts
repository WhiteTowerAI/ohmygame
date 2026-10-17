import { createPluginSetup, listPluginSetups, waitForRuntime } from "./api.js";
import { pluginBuilderHash } from "./routes.js";
import type { PluginSetupMode } from "../shared/plugin-setup.js";

let opening: Promise<void> | undefined;
export function openPluginBuilder(pluginId?: string, mode: PluginSetupMode = pluginId ? "configure" : "create", fresh = false): Promise<void> {
  return opening ??= (async () => {
    await waitForRuntime();
    const existing = pluginId && !fresh ? (await listPluginSetups()).find(session => session.pluginId === pluginId && session.mode === mode) : undefined;
    const session = existing ?? await createPluginSetup(pluginId, mode);
    window.location.hash = pluginBuilderHash(session.id);
  })().finally(() => { opening = undefined; });
}
