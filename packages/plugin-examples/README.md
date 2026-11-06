# Example plugins

Small working plugins, one for each kind of thing a plugin can add. Each one is
an npm package that passes `ohmygame-plugin check`, made from the same
template as `npm create ohmygame-plugin`. Add one to OhMyGame from its folder
(**Plugins › Add plugin › This computer**, with **Develop** on to try edits).

| Folder | Adds |
| --- | --- |
| [`level-ideas`](level-ideas) | A Skill |
| [`project-panel`](project-panel) | A panel and a command that opens it |
| [`hello-tools`](hello-tools) | Native code: a tool for the agent and a command |
| [`echo-server`](echo-server) | A local MCP server |
| [`canvas-game`](canvas-game) | A project type with a template |

Their publisher, `example`, isn't anyone's npm scope; publishing one means
renaming it to yours, in `package.json` and `.ohmygame-plugin/plugin.json`.
