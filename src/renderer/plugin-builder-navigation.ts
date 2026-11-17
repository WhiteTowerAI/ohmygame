import { createPluginSetup, listArchivedConversations, listConversations, listPluginSetups, waitForRuntime } from "./api.js";
import { pluginBuilderHash } from "./routes.js";
import { NEW_PLUGIN_TITLE } from "../shared/plugin-setup.js";

let opening: Promise<void> | undefined;
/** Prompts to put in a workspace's composer when it next opens, by workspace. */
const pendingPrompts = new Map<string, string>();

/** The prompt `openPluginBuilder` left for a workspace, once. */
export function takePendingBuilderPrompt(sessionId: string): string | undefined {
  const prompt = pendingPrompts.get(sessionId);
  pendingPrompts.delete(sessionId);
  return prompt;
}

/**
 * Opens the AI workspace of the plugin `pluginId`, or of a new plugin. A
 * `prompt` waits in its composer for the person to send.
 */
export function openPluginBuilder(pluginId?: string, options: { prompt?: string } = {}): Promise<void> {
  // A request to give its workspace waits for an open already on its way, rather than being lost to it.
  if (opening && options.prompt) return opening.then(() => openPluginBuilder(pluginId, options));
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
    if (options.prompt) pendingPrompts.set(session.id, options.prompt);
    window.location.hash = pluginBuilderHash(session.id);
  })().finally(() => { opening = undefined; });
}

async function findAsync<T>(items: readonly T[], test: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (const item of items) if (await test(item)) return item;
  return undefined;
}

/** Lines of a log the agent gets with a request to fix what it says. */
const FIX_LOG_LINES = 30;

/**
 * What asks a plugin's workspace agent to fix what its installed version
 * logged: its errors, newest last; in English, as all text sent to the agent.
 */
export function fixPluginPrompt(errors: readonly string[]): string {
  return [
    "The installed version of this plugin logged these errors. Find the cause in the draft, fix it, prepare it again, and say what you changed and how you checked it.",
    "",
    "```",
    ...errors.slice(-FIX_LOG_LINES),
    "```",
  ].join("\n");
}
