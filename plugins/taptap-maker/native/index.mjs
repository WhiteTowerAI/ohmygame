// TapTap Maker for OhMyGame: the panel's commands, the agent's preview tool
// and the Maker project type. The Maker CLI lives in the plugin's data folder,
// shared by every project; its sign-in stays in the person's home folder.
import * as maker from "./maker.mjs";

export function activate(context) {
  const call = (handler) => (input, options) => {
    const workspace = context.project?.folder;
    if (!workspace) throw new Error("TapTap Maker works in a project");
    return handler(
      {
        directory: context.dataFolder,
        workspace,
        signal: options.signal,
        progress: (message, url) =>
          options.progress(message, url ? { url } : undefined),
      },
      input ?? {},
    );
  };
  context.registerCommand("status", call(maker.status));
  context.registerCommand("ready", call(maker.ready));
  context.registerCommand("prepare", call(maker.prepare));
  context.registerCommand("signIn", call(maker.signIn));
  context.registerCommand("projects", call(maker.projects));
  context.registerCommand("create", call(maker.create));
  context.registerCommand("bind", call(maker.bind));
  context.registerCommand(
    "preview",
    call((options, input) => maker.preview(options, input.action)),
  );
  context.registerTool(
    "maker_preview",
    call((options, input) => maker.preview(options, input.action)),
  );
  // A new Maker project starts empty apart from ohmygame.json; the panel
  // creates or connects the Maker project, which needs a signed-in account.
  context.registerProjectType("maker", { createProject: () => null });
}
