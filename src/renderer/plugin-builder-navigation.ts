import { createPluginSetup, listArchivedConversations, listConversations, listPluginSetups, waitForRuntime } from "./api.js";
import { pluginBuilderHash } from "./routes.js";
import { NEW_PLUGIN_TITLE } from "../shared/plugin-setup.js";

let opening: Promise<void> | undefined;
/** Opens the AI workspace of the plugin `pluginId`, or of a new plugin. */
export function openPluginBuilder(pluginId?: string): Promise<void> {
  return opening ??= (async () => {
    await waitForRuntime();
    const sessions = await listPluginSetups();
    // A plugin has one workspace, like a project, whichever way it began: its newest, as the list is newest first.
    // A new plugin picks up a workspace nothing was said in, rather than leaving another empty one behind;
    // one whose naming failed still says "New plugin", so its conversations, archived ones too, are checked.
    const existing = pluginId ? sessions.find(session => session.pluginId === pluginId)
      : await findAsync(sessions, async session => !session.pluginId && session.title === NEW_PLUGIN_TITLE && session.status === "idle"
        && (await Promise.all([listConversations(session.projectId), listArchivedConversations(session.projectId)]))
          .flat().every(conversation => conversation.messageCount === 0));
    const session = existing ?? await createPluginSetup(pluginId, pluginId ? "edit" : "create");
    window.location.hash = pluginBuilderHash(session.id);
  })().finally(() => { opening = undefined; });
}

async function findAsync<T>(items: readonly T[], test: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (const item of items) if (await test(item)) return item;
  return undefined;
}
