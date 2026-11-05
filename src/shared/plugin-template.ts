import { PLUGIN_HOST_API_VERSION, PLUGIN_MANIFEST_SCHEMA_URL, RESERVED_PUBLISHERS } from "./plugin-manifest.js";

// The files of a new plugin package, for `npm create ohmygame-plugin` and the
// package the Plugin Builder exports: the manifest, package.json named so npm
// vouches for the publisher, both locales, a README and a workflow that
// publishes with provenance, plus a small working example of each part.

export const PLUGIN_TEMPLATE_PARTS = ["skills", "panel", "native", "mcp", "projectType"] as const;
export type PluginTemplatePart = (typeof PLUGIN_TEMPLATE_PARTS)[number];

export interface PluginTemplateOptions {
  /** The npm scope, which is the plugin's publisher. */
  publisher: string;
  name: string;
  displayName: string;
  description: string;
  parts: readonly PluginTemplatePart[];
}

/** A publisher or name: lowercase letters, digits and single hyphens, as plugin ids take. */
const ID_PART = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why the publisher or name can't be used, or undefined. */
export function pluginTemplateIssue(options: Pick<PluginTemplateOptions, "publisher" | "name">): string | undefined {
  if (!ID_PART.test(options.publisher)) return `${options.publisher} isn't a publisher: use lowercase letters, digits and hyphens, as in your npm scope`;
  if (RESERVED_PUBLISHERS.has(options.publisher)) return `The publisher ${options.publisher} is kept for OhMyGame; use your npm scope`;
  if (!ID_PART.test(options.name)) return `${options.name} isn't a plugin name: use lowercase letters, digits and hyphens`;
  return undefined;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5" fill="#5b6cff"/><path d="M8 12h8M12 8v8" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>\n`;

/** The new package's files by path, `/`-separated. */
export function pluginTemplate(options: PluginTemplateOptions): Record<string, string> {
  const issue = pluginTemplateIssue(options);
  if (issue) throw new Error(issue);
  const parts = new Set(options.parts);
  const id = `${options.publisher}/${options.name}`;
  const files: Record<string, string> = {};
  const strings: Record<string, string> = { "plugin.name": options.displayName, "plugin.description": options.description };
  const capabilities: Record<string, unknown> = {};
  const contributes: Record<string, unknown> = {};
  const commands: unknown[] = [];
  const published = [".ohmygame-plugin", "assets", "locales"];

  if (parts.has("skills")) {
    contributes.skills = "./skills/";
    published.push("skills");
    files[`skills/${options.name}/SKILL.md`] = `---
name: ${options.name}
description: What this Skill does and when the agent should use it. Say it in one or two sentences.
---

# ${options.displayName}

Write what the agent should do, in steps it wouldn't work out by itself. Keep
long details in files beside this one and say when to read them.
`;
  }

  if (parts.has("panel")) {
    published.push("panel");
    contributes.panels = [{ id: "main", title: "%panel.title%", icon: "./assets/icon.svg", area: "right", entry: "./panel/index.html" }];
    strings["panel.title"] = options.displayName;
    strings["command.open"] = `Open ${options.displayName}`;
    commands.push({ id: "open", title: "%command.open%", run: { openPanel: "main" }, slots: [{ slot: "project.menu" }] });
    files["panel/index.html"] = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.displayName)}</title>
    <link rel="stylesheet" href="/_ohmygame/plugin-ui.css" />
    <script type="module" src="/_ohmygame/ui/1/index.js"></script>
    <script type="module" src="./main.js"></script>
  </head>
  <body>
    <omg-page heading="${escapeHtml(options.displayName)}" description="${escapeHtml(options.description)}">
      <omg-section heading="Project">
        <p id="project">Connecting…</p>
${parts.has("native") ? `        <omg-command-button command="hello" variant="primary">Say hello</omg-command-button>\n` : ""}      </omg-section>
    </omg-page>
  </body>
</html>
`;
    files["panel/main.js"] = `// The page's own behaviour. The components connect themselves; this asks the
// app about the project. Pages can't load scripts from other sites.
import { connect } from "/_ohmygame/plugin-ui.js";

const host = await connect();
const project = await host.request("project.info");
document.getElementById("project").textContent = \`\${project.name} (\${project.type})\`;
`;
  }

  if (parts.has("native")) {
    published.push("native", "tools");
    capabilities.native = true;
    contributes.tools = [{ name: "hello", description: `Says hello from ${options.displayName}. Replace it with what the plugin does.`, input: "./tools/hello.input.json" }];
    strings["command.hello"] = "Say hello";
    commands.push({ id: "hello", title: "%command.hello%", run: { native: "hello", changesFiles: false } });
    files["tools/hello.input.json"] = json({ type: "object", properties: { name: { type: "string", description: "Who to greet" } }, additionalProperties: false });
    files["native/index.mjs"] = `// Runs in OhMyGame's extension host, a Node process for each project. Only
// the tools and commands the manifest declares can be registered.
export function activate(context) {
  context.registerTool("hello", async (input, options) => {
    options.progress("Saying hello…");
    return { text: \`Hello, \${input.name ?? "there"}, from \${context.project?.folder ?? "OhMyGame"}\` };
  });
  context.registerCommand("hello", async () => ({ text: \`Hello from \${context.project?.folder ?? "OhMyGame"}\` }));
}
`;
  }

  if (parts.has("mcp")) {
    published.push("mcp");
    capabilities.processes = ["node"];
    contributes.mcpServers = [{ id: "server", title: "%mcp.title%", command: "node", args: ["./mcp/server.mjs"], tools: ["echo"] }];
    strings["mcp.title"] = options.displayName;
    files["mcp/server.mjs"] = MCP_SERVER;
  }

  if (parts.has("projectType")) {
    published.push("template");
    contributes.projectTypes = [{ id: "game", title: "%type.title%", description: "%type.description%", icon: "./assets/icon.svg", template: "./template", preview: "web" }];
    strings["type.title"] = options.displayName;
    strings["type.description"] = options.description;
    files["template/index.html"] = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.displayName)}</title>
  </head>
  <body>
    <canvas id="game" width="640" height="360"></canvas>
    <script type="module" src="./main.js"></script>
  </body>
</html>
`;
    files["template/main.js"] = `const canvas = document.getElementById("game");
const context = canvas.getContext("2d");
context.fillStyle = "#5b6cff";
context.fillRect(0, 0, canvas.width, canvas.height);
`;
    // npm leaves .gitignore files out; OhMyGame renames this one when it adds the package.
    files["template/gitignore"] = "node_modules/\ndist/\n";
  }

  if (commands.length) contributes.commands = commands;
  files[".ohmygame-plugin/plugin.json"] = json({
    $schema: PLUGIN_MANIFEST_SCHEMA_URL,
    id,
    version: "0.1.0",
    engines: { "ohmygame-api": `^${PLUGIN_HOST_API_VERSION}` },
    displayName: "%plugin.name%",
    description: "%plugin.description%",
    icon: "./assets/icon.svg",
    ...(parts.has("panel") ? { ui: { major: 1 } } : {}),
    ...(capabilities.native ? { entrypoints: { native: "./native/index.mjs" } } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    contributes,
  });
  files["assets/icon.svg"] = ICON;
  files["locales/en.json"] = json(strings);
  // The same text until it is translated; the app falls back to en for a missing key.
  files["locales/zh-CN.json"] = json(strings);
  files["package.json"] = pluginPackageJson(options, "0.1.0", published);
  files["README.md"] = pluginReadme(options);
  files[".github/workflows/publish.yml"] = PUBLISH_WORKFLOW;
  files[".gitignore"] = "node_modules/\n*.tgz\n";
  return files;
}

/** A package.json npm publishes the plugin with: its name is the plugin id under the publisher's scope. */
export function pluginPackageJson(options: Pick<PluginTemplateOptions, "publisher" | "name" | "description">, version: string, files: readonly string[]): string {
  return json({
    name: `@${options.publisher}/${options.name}`,
    version,
    description: options.description,
    keywords: ["ohmygame-plugin"],
    files: [...new Set(files)].sort(),
    scripts: { check: "ohmygame-plugin check", pack: "ohmygame-plugin pack" },
    devDependencies: { "@ohmygame/plugin-cli": `^${PLUGIN_HOST_API_VERSION}` },
    publishConfig: { access: "public" },
  });
}

export function pluginReadme(options: Pick<PluginTemplateOptions, "publisher" | "name" | "displayName" | "description">): string {
  const id = `${options.publisher}/${options.name}`;
  return `# ${options.displayName}

${options.description}

An [OhMyGame](https://github.com/WhiteTowerAI/ohmygame) plugin, \`${id}\`.

## Develop

1. \`npm install\`
2. In OhMyGame, open **Plugins › Add plugin › This computer**, choose this
   folder and turn on **Develop**. The app reloads the plugin when a file
   changes, with what npm would publish.
3. \`npm run check\` checks the package the way OhMyGame does when it's added.

Translate \`locales/zh-CN.json\`; until then it repeats \`locales/en.json\`.

## Publish

The npm package is \`@${id}\`: its scope is the plugin's publisher, so
OhMyGame only takes \`${id}\` from it. Raise \`version\` in both
\`package.json\` and \`.ohmygame-plugin/plugin.json\` for each release.

- \`npm run pack\` makes the \`.tgz\` npm would publish and checks it.
- \`.github/workflows/publish.yml\` publishes a GitHub release with
  provenance. Add \`repository\` to \`package.json\`, then set this repository
  up as a [trusted publisher](https://docs.npmjs.com/trusted-publishers) of
  the package on npmjs.com.
- Add a license before publishing.
`;
}

const PUBLISH_WORKFLOW = `name: Publish

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm install
      - run: npm run check
      - run: npm publish --provenance
`;

const MCP_SERVER = `// A local MCP server over stdio: one JSON-RPC message per line. OhMyGame
// starts it when an agent first needs one of its tools, and lists to agents
// only the tools the manifest names.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Says back what it was given. Replace it with what the server does.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

const send = (message) => process.stdout.write(\`\${JSON.stringify({ jsonrpc: "2.0", ...message })}\\n\`);

function answer(method, params) {
  if (method === "initialize")
    return { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "server", version: "0.1.0" } };
  if (method === "tools/list") return { tools };
  if (method === "tools/call" && params?.name === "echo") return { content: [{ type: "text", text: String(params.arguments?.text ?? "") }] };
  throw Object.assign(new Error(\`Unknown method \${method}\`), { code: -32601 });
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, method, params } = JSON.parse(line);
  // A notification has no id and gets no answer.
  if (id === undefined) continue;
  try {
    send({ id, result: answer(method, params) });
  } catch (error) {
    send({ id, error: { code: error.code ?? -32603, message: error.message } });
  }
}
`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
}
