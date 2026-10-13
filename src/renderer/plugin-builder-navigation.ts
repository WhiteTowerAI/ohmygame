import { createPluginSetup, listPluginSetups, waitForRuntime } from "./api.js";
import { pluginBuilderHash } from "./routes.js";

let opening: Promise<void> | undefined;
export function openPluginBuilder(pluginId?: string): Promise<void> {
  return opening ??= (async () => {
    await waitForRuntime();
    const existing = pluginId ? (await listPluginSetups()).find(session => session.pluginId === pluginId) : undefined;
    const session = existing ?? await createPluginSetup(pluginId);
    window.location.hash = pluginBuilderHash(session.id);
  })().finally(() => { opening = undefined; });
}
