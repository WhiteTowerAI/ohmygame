import { createPluginSetup, listConversations, listPluginSetups, waitForRuntime } from "./api.js";
import { pluginBuilderHash } from "./routes.js";
import { NEW_PLUGIN_TITLE, type PluginSetupMode } from "../shared/plugin-setup.js";

let opening: Promise<void> | undefined;
export function openPluginBuilder(pluginId?: string, mode: PluginSetupMode = pluginId ? "edit" : "create", fresh = false): Promise<void> {
  return opening ??= (async () => {
    await waitForRuntime();
    const sessions = fresh ? [] : await listPluginSetups();
    // A plugin has one workspace, like a project, whichever way it began: its newest, as the list is newest first.
    // A new plugin picks up a workspace nothing was said in, rather than leaving another empty one behind;
    // one whose naming failed still says "New plugin", so its conversations are checked too.
    const existing = pluginId ? sessions.find(session => session.pluginId === pluginId)
      : await findAsync(sessions, async session => !session.pluginId && session.title === NEW_PLUGIN_TITLE && session.status === "idle"
        && (await listConversations(session.projectId)).every(conversation => conversation.messageCount === 0));
    const session = existing ?? await createPluginSetup(pluginId, mode);
    window.location.hash = pluginBuilderHash(session.id);
  })().finally(() => { opening = undefined; });
}

async function findAsync<T>(items: readonly T[], test: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (const item of items) if (await test(item)) return item;
  return undefined;
}
