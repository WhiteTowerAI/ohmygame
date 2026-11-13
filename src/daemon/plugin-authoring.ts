import { readFile } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_HOST_API_VERSION, PluginManifestV2Schema } from "../shared/plugin-manifest.js";
import { pluginPackageFiles, type PluginTemplatePart } from "../shared/plugin-template.js";

// The plugin-creator Skill, which the Plugin Builder and game conversations
// make plugins with. SKILL.md holds what every plugin needs; each part's
// details are a reference the agent reads only when the plugin has that part.
// The examples come from the template `npm create ohmygame-plugin` writes, the
// field list from the manifest's schema and the page APIs from @ohmygame/plugin-ui,
// so none of them can fall behind what the app takes.

const SKILL = `---
name: plugin-creator
description: Creates or changes an OhMyGame plugin, such as Skills, a panel, commands, agent tools or an MCP service, then checks it and hands it over to install. Use when the person asks for a plugin, or for a Skill, panel, tool or integration they want to keep for their projects.
---

# OhMyGame plugin creator

An OhMyGame plugin is a folder with \`.ohmygame-plugin/plugin.json\` and the files it names. It is not a plugin or Skill for Claude Code, Codex or another coding agent: write it only in its folder in the workspace, never in an agent's own settings or Skills folders.

Read existing files before changing them. Make the smallest plugin that does what the person asked, and keep the parts and services they chose.

## Parts

Use only the parts the request needs, and read a part's reference before writing it:

- Guidance or a workflow for the agent: Skills. Read [references/skills.md](references/skills.md).
- A page in the project's workspace: \`contributes.panels\`. Read [references/panels.md](references/panels.md).
- A tool the agent calls, a command that runs code, or code that hears project events: native code. Read [references/native.md](references/native.md).
- An existing MCP service: \`contributes.mcpServers\`. Read [references/mcp.md](references/mcp.md).
- A kind of project with its own template: \`contributes.projectTypes\`. Read [references/project-types.md](references/project-types.md).
- A menu, toolbar or slash entry: \`contributes.commands\`. A command can send a prompt, call a tool, open a panel or the plugin's settings, open a link, or run native code.
- Anything else the manifest takes, such as \`themes\`, \`canvasNodes\`, \`canvasPresets\`, \`assetSources\`, \`previewDevices\`, \`previewFilters\`, \`inputMaps\`, \`providers\`, \`agents\` or \`settings\`: its section in [references/manifest.md](references/manifest.md), the JSON Schema the app checks every field against.

## Manifest

- \`id\` is \`personal/<name>\`, kebab-case. \`version\` is semver; raise it for each release. \`engines\` is \`{"ohmygame-api": "^${PLUGIN_HOST_API_VERSION}"}\`.
- \`displayName\` and \`description\` say what it does for the person. Add \`longDescription\`, \`examples\` (prompts to try it with), \`categories\`, \`appliesTo\` or \`icon\` only when they help.
- \`icon\` is a PNG, WebP or static SVG in the package, up to 1 MB and 2048 × 2048, such as \`"./assets/icon.svg"\`. Prefer a product's own logo, and keep pixel art as PNG. An SVG needs a \`viewBox\` and no scripts, styles, embedded images or outside resources. Record where an image came from and its terms.
- \`capabilities\` lists all the plugin asks for; ask for no more than its parts use. A plugin that only adds Skills, with no capabilities or configuration, applies by itself to every project \`appliesTo\` names, or to all of them. Any other plugin is turned on per project, and the person approves what it asks for.
- \`configuration\` holds settings the person fills in on the plugin's page: fields with camelCase ids, each with \`type\` (text, secret, path, boolean or select), \`title\`, and maybe \`description\`, \`required\`, \`options\` (select) or \`default\` (not for a secret). Native code reads them, and \`\${config.<id>}\` puts one in an MCP server's \`args\`, \`env\` or \`headers\`. A secret needs \`capabilities.secrets\`. Never write credentials into files or ask for them in chat.
- Paths are relative to the package. Never use absolute paths, remote URLs or this workspace's own paths.

## Check and hand over

1. Check the folder with the tool this conversation has: \`plugin_manage\` with action \`prepare\` in the Plugin Builder, or \`install_plugin\` anywhere else. Both check it as the app does when it is added.
2. Fix every error it reports and check again until it passes.
3. The check covers the package, not what it does. Try what you can, such as a script or an MCP server, and say what you couldn't.

When changing a plugin, keep its id, its configuration field ids and types, and an icon the person chose.

Finish with what the plugin adds, what you checked, and what the person still has to do, such as installing it, turning it on in a project or filling in its settings.
`;

const SKILLS = `# Skills

\`contributes.skills\` is \`"./skills/"\`, and each Skill is \`skills/<name>/SKILL.md\` with YAML frontmatter: \`name\`, the same as its folder (lowercase letters, digits and hyphens), and \`description\`.

- The agent sees only the description until it loads the Skill, so say in the third person what the Skill does and when to use it.
- Write only what the agent wouldn't know by itself: the person's conventions, the steps that must stay fixed, what goes wrong. Leave out what any capable agent already does.
- Keep SKILL.md short. Put details needed only sometimes in files beside it, such as \`references/<topic>.md\`, linked from where they apply and no deeper than one level.
- Add a script for a step that must run the same way every time, and assets only when the result uses them.
- Skills run in game projects with the app's own tools, such as image generation where it is set up. Don't bundle replacements for them.
`;

const PANELS = `# Panels

A panel is a page of the package that the app shows in a project's workspace, in \`area\` left, center, right or bottom. Its tab shows the plugin's \`icon\`, which a plugin with panels needs. Set \`"ui": {"major": 1}\` to use the app's components.

- The page loads only its own package's files and the app's: no inline scripts and no scripts from other sites, so its code goes in a module file beside it.
- It can't reach the network. Bundle what it shows, or have it run a native command that fetches it (see [native.md](native.md)), with the host in \`capabilities.network\`.
- It has no browser storage. \`host.request("storage.get")\` and \`"storage.set"\` keep its small values in the project.
- \`<link rel="stylesheet" href="/_ohmygame/plugin-ui.css">\` gives it the app's look, and \`/_ohmygame/ui/1/index.js\` the components, such as \`omg-page\`, \`omg-section\`, \`omg-list\`, \`omg-button\` and \`omg-command-button\`. [page-components.d.ts](page-components.d.ts) lists each one's attributes.
- \`connect()\` from \`/_ohmygame/plugin-ui.js\` gives the page \`host\`: \`host.request\`, \`host.files\` and events. [page-api.d.ts](page-api.d.ts) has all of them; the capability each needs, such as \`project.files\`, goes in \`capabilities\`.
- A command with \`run: {"openPanel": "<panel id>"}\` and the \`project.menu\` slot opens it from the project's menu, as in the example. Commands with the \`panel.toolbar\` slot show in the panel's toolbar.
`;

const NATIVE = `# Native code

\`entrypoints.native\` names an ES module that exports \`activate(context)\`, and \`capabilities.native\` is \`true\`. It runs in a Node process for each project with the person's own access, and the app warns them about that before it is installed or turned on. Use it only for what the other parts can't do: a tool the agent calls, a command that runs code, a hook, or a request the page can't make.

- \`context.registerTool(name, handler)\`, \`context.registerCommand(id, handler)\` and \`context.registerHook(event, handler)\` register only what the manifest declares: \`contributes.tools\`, commands with \`run.native\`, and \`contributes.hooks\`.
- A handler gets \`(input, call)\`. \`call\` has \`signal\`, \`progress(message, { url })\`, \`configuration\` (the plugin's settings) and \`turn\`. It returns a string or a JSON value; a tool's goes to the agent.
- \`context.project?.folder\` is the project's folder and \`context.dataFolder\` one only this plugin uses, kept between projects. \`context.onDispose(fn)\` runs when it stops.
- A tool's \`input\` is a JSON Schema file. A command that never changes the project's files sets \`changesFiles: false\`; one that does can be undone. \`timeoutSeconds\`, up to 3600, is for calls that take long.
- Hooks: \`asset.added\`, \`turn.completed\`, \`build.started\`, \`build.completed\` and \`files.changed\` only hear, and may return \`{ notice, tone }\` to show a toast. \`image.beforeGenerate\` may return a changed \`prompt\`, \`imageModel\`, \`size\`, \`resolution\`, \`aspectRatio\` or \`transparentBackground\`.
- API 2.5: \`tool.beforeCall\` must return \`{ decision: "allow" }\`, or \`{ decision: "deny" | "ask", reason }\` (reason ≤300 characters). It cannot change arguments, has a 10-second timeout, and fails closed. Ask requires one-call approval in an active app conversation. \`tool.afterCall\` observes the call and its status/text (≤8,000 characters), with no result changes. Native agents' own file/shell tools are outside this boundary.
- API 2.5: \`contributes.instructions\` is static plain text (1–8,000 characters), shown in full in review and plugin details, added for active project plugins before the user's own instructions. No file references, interpolation or localized keys.
- API 2.5: native messaging plugins ask for \`capabilities.sessions\` and run in the app host when enabled globally and explicitly granted. Guard \`if (!context.sessions) return\` for project activations. The app host has no \`context.project\`; \`context.configuration\` is its activation snapshot. Return promptly from activate and close connections with onDispose. Configuration changes restart activation; app host crashes reconnect with bounded retries/quarantine.
- \`context.sessions.request({ operation, ... }, { signal? })\`: projects → { projects, truncated }; conversations(projectId) → { conversations, truncated }; create(projectId) → { id }; read(projectId, conversationId) → { messages, truncated, status, needsApproval, cursor }; send(projectId, conversationId, text) → accepted { turnId }; stop(projectId, conversationId) → { stopped }; events(projectId, after?, waitMs?) → { cursor, reset, events }. Text is limited to 32,000 characters, reads to 200 messages/256,000 characters, lists to 500, event waits to 25 seconds. Assistant messages include status and bounded failure details even when text is empty. On reset, re-read and resume from its cursor. No approval API: notify the person to decide in OhMyGame. Sends reject busy/planned conversations and carry plugin attribution. Cancellation does not stop accepted turns; lost acknowledgements are ambiguous, never blindly retry sends/creates. Persist external message deduplication in the plugin's data folder.
- An asset source (\`contributes.assetSources\`) is a tab beside Local in the Library, outside any project, so \`context.project\` is unset. Its \`search\` command gets \`{ query, media, cursor }\` and returns \`{ items: [{ id, name, mediaType, thumbnail, author, license, url }], next }\`, with \`thumbnail\` an \`https:\` or \`data:image/…\` URL. Its \`fetch\` command gets \`{ id, mediaType }\`, saves the file in \`context.dataFolder\` and returns \`{ file, name, author, license, url }\` with \`file\` relative to that folder; the Library takes the file from there.
- List the hosts the code reaches in \`capabilities.network\` and the programs it runs in \`capabilities.processes\`.
`;

const MCP = `# MCP servers

\`contributes.mcpServers\` is a list, and \`tools\` names every tool a server may expose. Use a service that exists, and ask for details only the person knows; never invent an address or a command. For a new tool of the plugin's own, native code (see [native.md](native.md)) is simpler than a server.

- A remote server is \`{"id": "api", "title": "API", "url": "https://service.example/mcp", "tools": ["search"]}\`, with its host in \`capabilities.network\`, such as \`["service.example"]\`.
- A local one runs a command, such as \`{"id": "tool", "title": "Tool", "command": "npx", "args": ["-y", "package@1.2.3"], "tools": ["run"]}\`, with the command in \`capabilities.processes\`. Pin package versions. The example bundles a small server of its own.
- \`\${config.<id>}\` puts a setting in a local server's \`args\` or \`env\`, or a remote one's \`headers\`.
- A service that signs in with OAuth is added in Settings, under MCP Connections, not in a plugin.
- \`plugin_manage\` with action \`test\` and \`server\` tries a server in the Plugin Builder.
`;

const PROJECT_TYPES = `# Project types

\`contributes.projectTypes\` adds a kind of project to the new-project dialog. Its \`template\` folder is copied into each new project; npm leaves \`.gitignore\` out of packages, so name it \`gitignore\` and the app renames it. \`preview\` is \`web\` for a game the app's preview runs, \`web-build\` for one native code builds for the web, or \`native\` for one that runs outside the app.

A type without a template, or one that builds or runs its game, needs native code (see [native.md](native.md)): \`context.registerProjectType(id, { createProject, buildWeb, gameUse })\`. \`recognize\`, \`ready\`, \`panels\` and \`gameUse\` are in [manifest.md](manifest.md).
`;

const REFERENCES: Record<string, { notes: string; example?: PluginTemplatePart }> = {
  "skills.md": { notes: SKILLS, example: "skills" },
  "panels.md": { notes: PANELS, example: "panel" },
  "native.md": { notes: NATIVE, example: "native" },
  "mcp.md": { notes: MCP, example: "mcp" },
  "project-types.md": { notes: PROJECT_TYPES, example: "projectType" },
};

/** A working plugin with one part, from the package template. */
function example(part: PluginTemplatePart): string {
  const files = pluginPackageFiles({
    publisher: "personal",
    name: "example",
    displayName: "Example",
    description: "An example plugin.",
    parts: [part],
  });
  const fence = (file: string) => file.endsWith(".json") ? "json" : file.endsWith(".html") || file.endsWith(".svg") ? "html" : file.endsWith(".md") ? "markdown" : "js";
  return [
    "## Example",
    "",
    "A working plugin with only this part. Text such as `%plugin.name%` is looked up in `locales/<language>.json`, such as `locales/zh-CN.json` for Chinese; plain text works too.",
    ...Object.entries(files).filter(([file]) => file !== "locales/zh-CN.json").map(([file, contents]) => `\n### ${file}\n\n\`\`\`\`${fence(file)}\n${contents.trimEnd()}\n\`\`\`\``),
  ].join("\n");
}

/** Each field's JSON Schema under a heading, so a field is found by searching for it. */
function manifestReference(): string {
  const schema = PluginManifestV2Schema as unknown as { properties: Record<string, unknown>; required: string[] };
  const { contributes, ...fields } = schema.properties;
  const sections = [
    ...Object.entries(fields),
    ...Object.entries((contributes as { properties: Record<string, unknown> }).properties).map(([key, value]) => [`contributes.${key}`, value] as const),
  ];
  return [
    "# plugin.json",
    "",
    `The JSON Schema of each field of \`.ohmygame-plugin/plugin.json\`, as the app checks it. Required: ${schema.required.map((field) => `\`${field}\``).join(", ")}. No other fields are allowed. Search for a field's heading, such as \`## contributes.themes\`.`,
    ...sections.map(([field, value]) => `\n## ${field}\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``),
  ].join("\n") + "\n";
}

/**
 * The Skill's files by path inside its folder. The page API references are
 * copied from @ohmygame/plugin-ui; without them the Skill still works.
 */
export async function pluginCreatorSkill(pluginUiDirectory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = { "SKILL.md": SKILL, "references/manifest.md": manifestReference() };
  for (const [name, { notes, example: part }] of Object.entries(REFERENCES))
    files[`references/${name}`] = part ? `${notes}\n${example(part)}\n` : notes;
  const pages = { "references/page-api.d.ts": "index.d.ts", "references/page-components.d.ts": path.join("ui", "1", "index.d.ts") };
  for (const [name, source] of Object.entries(pages)) {
    const contents = await readFile(path.join(pluginUiDirectory, source), "utf8").catch(() => undefined);
    if (contents) files[name] = contents;
  }
  return files;
}
