import { createPluginSetup, listPluginSetups, waitForRuntime } from "./api.js";
import { pluginBuilderHash } from "./routes.js";
import { NEW_PLUGIN_TITLE, type PluginSetupMode } from "../shared/plugin-setup.js";

let opening: Promise<void> | undefined;
export function openPluginBuilder(pluginId?: string, mode: PluginSetupMode = pluginId ? "edit" : "create", fresh = false): Promise<void> {
  return opening ??= (async () => {
    await waitForRuntime();
    const sessions = fresh ? [] : await listPluginSetups();
    // A new plugin picks up a workspace nothing was said in, rather than leaving another one behind.
    // A plugin has one workspace, like a project, whichever way it began: its newest, as the list is newest first.
    const existing = sessions.find(session => pluginId ? session.pluginId === pluginId
      : !session.pluginId && session.title === NEW_PLUGIN_TITLE && session.status === "idle");
    const session = existing ?? await createPluginSetup(pluginId, mode);
    window.location.hash = pluginBuilderHash(session.id);
  })().finally(() => { opening = undefined; });
}
