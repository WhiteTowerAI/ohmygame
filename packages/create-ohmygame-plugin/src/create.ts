// `npm create ohmygame-plugin [folder]`: a new plugin package from the same
// template the Plugin Builder exports with, which passes OhMyGame's checks as
// it is. Asks for what it isn't told; `--yes` takes the defaults.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { PLUGIN_TEMPLATE_PARTS, pluginTemplate, pluginTemplateIssue, type PluginTemplatePart } from "../../../src/shared/plugin-template.js";

const USAGE = `Usage: npm create ohmygame-plugin [folder] -- [options]

Options:
  --publisher <scope>      Your npm scope, without @; the plugin's publisher
  --name <name>            The plugin's name; the folder's by default
  --display-name <text>    What the app calls it
  --description <text>     One sentence on what it does
  --parts <list>           Any of ${PLUGIN_TEMPLATE_PARTS.join(", ")}; skills by default
  -y, --yes                Ask nothing; take the defaults
  -h, --help`;

const PART_QUESTIONS: Record<PluginTemplatePart, string> = {
  skills: "Skills, instructions the agent follows",
  panel: "A panel, a page beside the project, with a command that opens it",
  native: "Native code, Node.js that adds tools for the agent and commands",
  mcp: "A local MCP server",
  projectType: "A project type, with a template for new projects",
};

const titleCase = (name: string) => name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      publisher: { type: "string" },
      name: { type: "string" },
      "display-name": { type: "string" },
      description: { type: "string" },
      parts: { type: "string" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length > 1) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const interactive = !values.yes && process.stdin.isTTY;
  const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (question: string, fallback: string | undefined) => {
    if (!prompt) return fallback ?? "";
    const answer = (await prompt.question(`${question}${fallback ? ` (${fallback})` : ""}: `)).trim();
    return answer || fallback || "";
  };
  try {
    const folder = path.resolve(positionals[0] ?? (await ask("Folder", "my-plugin")));
    const entries = await readdir(folder).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    });
    if (entries.length) throw new Error(`${folder} isn't empty; choose a new folder.`);
    const publisher = values.publisher ?? (await ask("Publisher, your npm scope without @", undefined));
    if (!publisher) throw new Error("Say the publisher with --publisher: your npm scope, without @.");
    const name = values.name ?? (await ask("Plugin name", path.basename(folder).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")));
    const issue = pluginTemplateIssue({ publisher, name });
    if (issue) throw new Error(issue);
    const displayName = values["display-name"] ?? (await ask("Display name", titleCase(name)));
    const description = values.description ?? (await ask("What it does, in one sentence", `${displayName} for OhMyGame.`));
    let parts: PluginTemplatePart[];
    if (values.parts !== undefined) {
      const named = values.parts.split(",").map((part) => part.trim()).filter(Boolean);
      const unknown = named.filter((part) => !(PLUGIN_TEMPLATE_PARTS as readonly string[]).includes(part));
      if (unknown.length) throw new Error(`There is no part ${unknown.join(", ")}; choose from ${PLUGIN_TEMPLATE_PARTS.join(", ")}.`);
      parts = named as PluginTemplatePart[];
    } else if (prompt) {
      parts = [];
      for (const part of PLUGIN_TEMPLATE_PARTS)
        if (/^y/i.test(await ask(`${PART_QUESTIONS[part]}? y/n`, part === "skills" ? "y" : "n"))) parts.push(part);
    } else parts = ["skills"];

    const files = pluginTemplate({ publisher, name, displayName, description, parts });
    for (const [file, text] of Object.entries(files)) {
      const target = path.join(folder, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, { flag: "wx" });
    }
    const relative = path.relative(process.cwd(), folder) || ".";
    console.log(`\nMade ${publisher}/${name} in ${relative}. Next:\n  cd ${relative}\n  npm install\n  npm run check\nThen add the folder in OhMyGame: Plugins › Add plugin › This computer, with Develop on.`);
    return 0;
  } finally {
    prompt?.close();
  }
}

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  },
);
