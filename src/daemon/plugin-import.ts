// Turns a plugin made for another agent (Claude Code, Codex, Agent Plugins, or
// a folder of Agent Skills) into an OhMyGame package, for Add plugin. What
// OhMyGame can use comes along: Skills, Claude's commands as Skills, and MCP
// servers. The rest is listed as left out. Nothing in the package runs.
import { cp, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DATA_ENV, PLUGIN_MANIFEST_SCHEMA_URL } from "../shared/plugin-manifest.js";
import { isPluginVersion, PLUGIN_MANIFEST_PATH, pluginSourcePath, type ImportedPluginFormat, type PluginImport } from "../shared/plugins.js";
import { frontmatter, inside, isWithin, packageSkills, PluginConversionError, skillFolders, skillName } from "./plugin-conversion.js";
import { parseSkillMetadata } from "./skill-metadata.js";

type Json = Record<string, unknown>;

/** Where a marketplace's plugin lives: a folder beside the marketplace, or a GitHub repository. */
export type MarketplaceLocation = { path: string } | { repository: string; ref?: string; path?: string };

export type DetectedPlugin =
  | { kind: "plugin"; format: ImportedPluginFormat; manifest: Json }
  | { kind: "marketplace"; entries: Array<{ name: string; description?: string; location?: MarketplaceLocation }> };

const MARKETPLACES = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];
/** Where a server made for another agent runs from: the original package, copied whole. */
const ORIGINAL = "plugin";
const MAX_MARKETPLACE_PLUGINS = 1000;

/**
 * What a package made for another agent is, or undefined for one that isn't.
 * A marketplace counts only when `marketplaces` allows, so a folder chosen
 * from one is read as the plugin it is.
 */
export async function detectAgentPlugin(root: string, { marketplaces }: { marketplaces: boolean }): Promise<DetectedPlugin | undefined> {
  const portable = await readJson(root, "plugin.json");
  if (portable && typeof portable.$schema === "string" && portable.$schema.includes("agent-plugins.org"))
    return { kind: "plugin", format: "agent-plugins", manifest: portable };
  const codex = await readJson(root, ".codex-plugin/plugin.json");
  if (codex) return { kind: "plugin", format: "codex", manifest: codex };
  const claude = await readJson(root, ".claude-plugin/plugin.json");
  if (claude) return { kind: "plugin", format: "claude", manifest: claude };
  if (marketplaces)
    for (const file of MARKETPLACES) {
      const listed = await readJson(root, file);
      if (Array.isArray(listed?.plugins)) return { kind: "marketplace", entries: marketplaceEntries(listed) };
    }
  // Claude Code needs no manifest: its default folders say what a plugin has.
  if ((await skillFolders(root)).length || (await markdownFiles(path.join(root, "commands"))).length || await isFile(path.join(root, ".mcp.json")))
    return { kind: "plugin", format: "skills", manifest: {} };
  return undefined;
}

function marketplaceEntries(listed: Json): Extract<DetectedPlugin, { kind: "marketplace" }>["entries"] {
  const pluginRoot = string(object(listed.metadata).pluginRoot) ?? "";
  return (listed.plugins as unknown[]).slice(0, MAX_MARKETPLACE_PLUGINS).flatMap((item) => {
    const entry = object(item);
    const name = string(entry.name);
    if (!name) return [];
    const description = string(entry.description);
    const location = marketplaceLocation(entry.source, pluginRoot);
    return [{ name: name.slice(0, 100), ...(description ? { description: description.slice(0, 300) } : {}), ...(location ? { location } : {}) }];
  });
}

function marketplaceLocation(source: unknown, pluginRoot: string): MarketplaceLocation | undefined {
  const local = (value: string) => {
    // A bare name sits under the marketplace's plugin root; `./x` is from the top.
    const joined = /^\.{1,2}(?:\/|$)/.test(value) ? value : path.posix.join(pluginRoot, value);
    const folder = pluginSourcePath(path.posix.normalize(joined));
    return folder ? { path: folder } : undefined;
  };
  if (typeof source === "string") return local(source);
  const entry = object(source);
  const ref = string(entry.ref);
  const pinned = ref && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(ref) && !ref.includes("..") ? { ref } : {};
  if (entry.source === "local" && string(entry.path)) return local(string(entry.path)!);
  const repository = entry.source === "github" ? gitHubRepository(string(entry.repo)) : entry.source === "url" || entry.source === "git-subdir" ? gitHubRepository(string(entry.url)) : undefined;
  if (!repository) return undefined;
  if (entry.source !== "git-subdir") return { repository, ...pinned };
  const folder = string(entry.path) ? pluginSourcePath(path.posix.normalize(string(entry.path)!)) : undefined;
  return folder ? { repository, ...pinned, path: folder } : undefined;
}

/** `owner/repo` from GitHub's shorthand, page or clone address; undefined for another host. */
function gitHubRepository(value: string | undefined): string | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(value?.trim() ?? "");
  return match && !/^\.+$/.test(match[2]!) ? `${match[1]}/${match[2]}` : undefined;
}

export interface ImportOptions {
  /** The plugin id's publisher: the GitHub owner, or `local`. */
  publisher: string;
  /** The name when the manifest gives none: the repository's or folder's. */
  name: string;
  /** The version to give it, from the one its manifest declares, if a valid one. */
  version: (declared: string | undefined) => Promise<string>;
}

/**
 * Writes an OhMyGame package for the plugin at `root` into `work/package` and
 * returns that folder. `root` is only read; `work` is an empty folder.
 * Throws `PluginConversionError` when nothing in it works in OhMyGame.
 */
export async function importAgentPlugin(
  detected: Extract<DetectedPlugin, { kind: "plugin" }>,
  root: string,
  work: string,
  options: ImportOptions,
): Promise<{ root: string; imported: PluginImport }> {
  const { format, manifest } = detected;
  const skipped: PluginImport["skipped"] = [];
  const openai = object(object(manifest.extensions)["com.openai"]);
  const face = format === "codex" ? object(manifest.interface) : format === "agent-plugins" ? object(openai.interface) : {};
  const name = skillName(string(manifest.name)) ?? skillName(options.name) ?? "plugin";
  const displayName = (string(face.displayName) ?? string(manifest.displayName) ?? string(manifest.name) ?? name).slice(0, 80);
  const description = (string(face.shortDescription) ?? string(manifest.description) ?? displayName).slice(0, 300);
  const declared = string(manifest.version);
  const version = await options.version(declared && isPluginVersion(declared) ? declared : undefined);
  const id = `${options.publisher}/${name}`;

  // Skills are changed in a copy: commands become Skills, and scripts they use move in.
  const staging = path.join(work, "staging");
  await cp(root, staging, { recursive: true, filter: async (source) => !(await lstat(source)).isSymbolicLink() });
  const folders = new Set<string>();
  for (const declaredPath of locations(manifest.skills, format === "skills" ? "." : "skills")) {
    const at = await inside(staging, declaredPath).catch(() => undefined);
    const stats = at ? await lstat(at).catch(() => undefined) : undefined;
    if (stats?.isDirectory()) for (const folder of await skillFolders(at!)) folders.add(folder);
    else if (stats?.isFile() && path.basename(at!) === "SKILL.md") folders.add(path.dirname(at!));
  }
  if (format === "claude" || format === "skills")
    for (const folder of await commandSkills(staging, manifest.commands, skipped)) folders.add(folder);
  for (const folder of folders) await bringScripts(staging, folder, skipped);

  const icon = [string(manifest.icon), string(face.logo), string(face.composerIcon)].find((value) => value && /\.(?:svg|png|webp)$/i.test(value));
  const target = path.join(work, "package");
  if (folders.size) {
    await packageSkills({
      root: staging,
      manifest: {
        name, version, description,
        skills: [...folders].map((folder) => path.relative(staging, path.join(folder, "SKILL.md")).split(path.sep).join("/")),
        interface: { displayName, ...(icon ? { icon: { type: "asset", path: icon } } : {}) },
      },
    }, target, { id });
  }

  const mcp = mcpServers(await mcpDefinitions(format, manifest, root), object(manifest.userConfig), skipped);
  if (!folders.size && !mcp.servers.length)
    throw new PluginConversionError(`Nothing in ${displayName} works in OhMyGame`);
  if (!folders.size) {
    await mkdir(path.join(target, path.dirname(PLUGIN_MANIFEST_PATH)), { recursive: true });
    await writeFile(path.join(target, PLUGIN_MANIFEST_PATH), JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA_URL, id, version, engines: { "ohmygame-api": "^2.0.0" }, displayName, description }));
  }
  if (mcp.servers.length) {
    // Servers run from the original package, as their own agent would run them.
    await cp(root, path.join(target, ORIGINAL), { recursive: true, filter: async (source) => !(await lstat(source)).isSymbolicLink() });
    const file = path.join(target, PLUGIN_MANIFEST_PATH);
    const written = JSON.parse(await readFile(file, "utf8")) as Json;
    const capabilities = {
      ...(mcp.processes.size ? { processes: [...mcp.processes] } : {}),
      ...(mcp.network.size ? { network: [...mcp.network] } : {}),
      ...(mcp.secrets ? { secrets: true } : {}),
    };
    await writeFile(file, `${JSON.stringify({
      ...written,
      // Servers that leave out `tools`.
      engines: { "ohmygame-api": "^2.36.0" },
      ...(!folders.size && icon && await isFile(path.join(root, icon)) ? { icon: `./${ORIGINAL}/${icon.replace(/^\.\//, "")}` } : {}),
      ...(Object.keys(mcp.configuration).length ? { configuration: mcp.configuration } : {}),
      capabilities,
      contributes: { ...object(written.contributes), mcpServers: mcp.servers },
    }, null, 2)}\n`);
  }

  await listLeftOut(format, manifest, openai, root, skipped);
  return { root: target, imported: { format, skipped } };
}

/** A manifest's paths for one part, beside its default folder, which its agent reads either way. */
function locations(value: unknown, fallback: string): string[] {
  const declared = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === "string");
  return [...new Set([fallback, ...declared])];
}

/**
 * Claude's commands as Skills, in a folder of the staging copy. A command that
 * runs a shell command into its prompt (`` !`…` ``) can't be one.
 */
async function commandSkills(staging: string, declared: unknown, skipped: PluginImport["skipped"]): Promise<string[]> {
  const files: Array<{ file: string; base: string }> = [];
  for (const location of locations(declared, "commands")) {
    const at = await inside(staging, location).catch(() => undefined);
    const stats = at ? await lstat(at).catch(() => undefined) : undefined;
    if (stats?.isDirectory()) files.push(...(await markdownFiles(at!)).map((file) => ({ file, base: at! })));
    else if (stats?.isFile() && at!.endsWith(".md")) files.push({ file: at!, base: path.dirname(at!) });
  }
  let output = path.join(staging, "ohmygame-commands");
  for (let index = 2; await exists(output); index++) output = path.join(staging, `ohmygame-commands-${index}`);
  const folders: string[] = [];
  const names = new Set<string>();
  for (const { file, base } of files.sort((a, b) => a.file.localeCompare(b.file))) {
    const command = path.relative(base, file).replace(/\.md$/, "").split(path.sep).join(":");
    const text = await readFile(file, "utf8");
    if (/!`[^`\n]+`/.test(text)) {
      skipped.push({ part: "command", name: `/${command}` });
      continue;
    }
    let name = skillName(command) ?? "command";
    for (let index = 2; names.has(name); index++) name = `${skillName(command) ?? "command"}-${index}`;
    names.add(name);
    let metadata: { description?: string } = {};
    try {
      metadata = parseSkillMetadata(text);
    } catch {
      // Its frontmatter is replaced below.
    }
    const body = text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---(?:[ \t]*\r?\n|$)/, "");
    const first = body.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean);
    const folder = path.join(output, name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), frontmatter(text, name, (metadata.description ?? first ?? `The /${command} command`).slice(0, 1024)));
    folders.push(folder);
  }
  return folders;
}

const ROOT_REFERENCE = /\$\{?(?:CLAUDE_)?PLUGIN_ROOT\}?((?:\/[^\s"'`)\]>]+)?)/g;
const DATA_REFERENCE = /\$\{?(?:CLAUDE_)?PLUGIN_DATA\}?/;

/**
 * Points a Skill's references to its plugin's folder (`${CLAUDE_PLUGIN_ROOT}/…`)
 * at a copy in the Skill's own folder, since agents get each Skill's folder
 * alone. The folder a referenced file is in comes along, so its neighbours do too.
 */
async function bringScripts(staging: string, folder: string, skipped: PluginImport["skipped"]): Promise<void> {
  const brought = new Map<string, string>();
  let missing = false;
  for (const file of await markdownFiles(folder)) {
    const text = await readFile(file, "utf8");
    if (DATA_REFERENCE.test(text)) missing = true;
    const replacements: Array<{ whole: string; to: string }> = [];
    for (const match of text.matchAll(ROOT_REFERENCE)) {
      const rest = match[1] ?? "";
      const at = rest ? await inside(staging, `.${rest}`).catch(() => undefined) : undefined;
      const stats = at ? await lstat(at).catch(() => undefined) : undefined;
      if (!at || !stats || stats.isSymbolicLink()) {
        missing = true;
        continue;
      }
      // Already in the Skill's folder: a path from there.
      if (isWithin(folder, at)) {
        replacements.push({ whole: match[0], to: path.relative(folder, at).split(path.sep).join("/") || "." });
        continue;
      }
      const source = stats.isDirectory() ? at : path.dirname(at);
      if (source === staging || (await skillFolders(source)).length) {
        // Copying it would copy the whole plugin, or other Skills.
        missing = true;
        continue;
      }
      let copy = brought.get(source);
      if (!copy) {
        copy = path.join("_plugin", path.relative(staging, source));
        await cp(source, path.join(folder, copy), { recursive: true, filter: async (item) => !(await lstat(item)).isSymbolicLink() });
        brought.set(source, copy);
      }
      replacements.push({ whole: match[0], to: path.join(copy, path.relative(source, at)).split(path.sep).join("/") });
    }
    if (replacements.length) {
      let next = text;
      // Longest first, so a path that begins another doesn't change it.
      for (const { whole, to } of replacements.sort((a, b) => b.whole.length - a.whole.length)) next = next.split(whole).join(to);
      await writeFile(file, next);
    }
  }
  if (missing) skipped.push({ part: "script", name: path.basename(folder) });
}

/** The MCP servers a package declares, by name, from its files and its manifest. */
async function mcpDefinitions(format: ImportedPluginFormat, manifest: Json, root: string): Promise<Json> {
  const found: Json = {};
  const add = (value: unknown) => {
    const servers = object(value);
    Object.assign(found, Object.keys(object(servers.mcpServers)).length ? object(servers.mcpServers) : servers);
  };
  const files = format === "agent-plugins" ? ["mcp.json"] : [".mcp.json"];
  for (const value of Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers]) {
    if (typeof value === "string") files.push(value);
    else if (value && typeof value === "object") add(value);
  }
  for (const file of new Set(files)) {
    // `.mcp.json` is hidden, which `inside` refuses; a file in the package, not a link, will do.
    const at = path.resolve(root, file);
    if (isWithin(root, at) && at !== root && await isFile(at)) add(await readJson(root, path.relative(root, at)));
  }
  return found;
}

interface McpBuild {
  servers: Json[];
  configuration: Record<string, Json>;
  processes: Set<string>;
  network: Set<string>;
  secrets: boolean;
}

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::-([^}]*))?\}/g;
/** Variables no setting can stand for: OhMyGame gives a server its own data folder, and nothing of the person's environment. */
const UNSUPPORTED = new Set(["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "CLAUDE_PROJECT_DIR", "CLAUDE_SKILL_DIR", "HOME", "USER", "PATH", "PWD", "TMPDIR", PLUGIN_DATA_ENV]);
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;
const HTTP_TYPES = new Set(["http", "sse", "streamable-http", "streamableHttp"]);

/**
 * OhMyGame's form of each server: an environment variable or a Claude
 * `userConfig` value it names becomes a setting the person fills in. One that
 * can't be expressed, such as a program named by its path or a variable of
 * the person's environment, is left out.
 */
function mcpServers(definitions: Json, userConfig: Json, skipped: PluginImport["skipped"]): McpBuild {
  const build: McpBuild = { servers: [], configuration: {}, processes: new Set(), network: new Set(), secrets: false };
  const fields = new Map<string, string>();
  const ids = new Set<string>();
  for (const [name, value] of Object.entries(definitions).slice(0, 30)) {
    const server = object(value);
    // Settings this server needs, kept only if all of it converts.
    const pending = new Map<string, { field: string; spec: Json }>();
    const fieldFor = (variable: string, fallback: string | undefined, secretUse: boolean): string | undefined => {
      const configured = variable.startsWith("user_config.") ? object(userConfig[variable.slice("user_config.".length)]) : undefined;
      if (!configured && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) || UNSUPPORTED.has(variable))) return undefined;
      const key = configured ? variable.slice("user_config.".length) : variable;
      const known = fields.get(variable) ?? pending.get(variable)?.field;
      // A secret already a setting still can't go in a URL.
      if (known) return !secretUse && (build.configuration[known] ?? pending.get(variable)?.spec)?.type === "secret" ? undefined : known;
      const base = configName(key);
      let field = base;
      for (let index = 2; Object.hasOwn(build.configuration, field) || [...pending.values()].some((item) => item.field === field); index++) field = `${base}${index}`;
      const secret = configured ? configured.sensitive === true : SECRET_NAME.test(key);
      if (secret && !secretUse) return undefined;
      const fallbackValue = string(configured?.default) ?? fallback;
      pending.set(variable, {
        field,
        spec: {
          type: secret ? "secret" : configured && (configured.type === "directory" || configured.type === "file") ? "path" : "text",
          title: (string(configured?.title) ?? key).slice(0, 200),
          ...(string(configured?.description) ? { description: string(configured?.description)!.slice(0, 500) } : {}),
          ...(fallbackValue !== undefined && !secret ? { default: fallbackValue } : { required: true }),
        },
      });
      return field;
    };
    /** A value with its variables as settings; `.` for the plugin's folder where a path may be relative to it. */
    const template = (text: string, use: "url" | "header" | "launch"): string | undefined => {
      let failed = text.length > 2000;
      const result = text.replace(VARIABLE, (whole, variable: string, fallback: string | undefined) => {
        if (variable === "CLAUDE_PLUGIN_ROOT" || variable === "PLUGIN_ROOT") {
          if (use !== "launch") failed = true;
          return ".";
        }
        const field = fieldFor(variable, fallback, use !== "url");
        if (!field) failed = true;
        return `\${config.${field}}`;
      });
      // What the adapter would read from the environment by itself.
      return failed || /\$env:\w+|\{env:\w+\}|\$\{(?!config\.)/.test(result) ? undefined : result;
    };
    const converted = (() => {
      const url = string(server.url);
      if (url || HTTP_TYPES.has(String(server.type))) {
        const address = url ? template(url, "url") : undefined;
        const host = address ? /^https?:\/\/([^/?#]*)/i.exec(address)?.[1] : undefined;
        if (!address || !host || host.includes("${") || host.includes("@")) return undefined;
        let parsed: URL;
        try {
          parsed = new URL(address.replace(/\$\{config\.[a-zA-Z0-9]+\}/g, "x"));
        } catch {
          return undefined;
        }
        if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) return undefined;
        const headers: Record<string, string> = {};
        for (const [header, raw] of Object.entries(object(server.headers))) {
          const filled = typeof raw === "string" && /^[A-Za-z0-9-]{1,64}$/.test(header) ? template(raw, "header") : undefined;
          if (filled === undefined) return undefined;
          headers[header] = filled;
        }
        return { server: { url: address, ...(Object.keys(headers).length ? { headers } : {}) }, network: parsed.hostname };
      }
      const command = string(server.command);
      if (!command || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(command)) return undefined;
      const args: string[] = [];
      for (const raw of Array.isArray(server.args) ? server.args.slice(0, 51) : []) {
        const filled = typeof raw === "string" ? template(raw, "launch") : undefined;
        if (filled === undefined || args.length === 50) return undefined;
        args.push(filled);
      }
      const env: Record<string, string> = {};
      for (const [variable, raw] of Object.entries(object(server.env))) {
        const filled = typeof raw === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(variable) && variable.toUpperCase() !== PLUGIN_DATA_ENV ? template(raw, "launch") : undefined;
        if (filled === undefined) return undefined;
        env[variable] = filled;
      }
      return { server: { command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}), cwd: `./${ORIGINAL}/` }, process: command };
    })();
    const processes = converted?.process ? new Set([...build.processes, converted.process]) : build.processes;
    const network = converted?.network ? new Set([...build.network, converted.network]) : build.network;
    if (!converted || processes.size > 30 || network.size > 30) {
      skipped.push({ part: "mcp", name });
      continue;
    }
    let id = skillName(name) ?? "server";
    for (let index = 2; ids.has(id); index++) id = `${skillName(name) ?? "server"}-${index}`;
    ids.add(id);
    build.servers.push({ id, title: name.slice(0, 200), ...converted.server });
    build.processes = processes;
    build.network = network;
    for (const [variable, { field, spec }] of pending) {
      fields.set(variable, field);
      build.configuration[field] = spec;
      if (spec.type === "secret") build.secrets = true;
    }
  }
  return build;
}

/** `API_KEY` or `api_key` as `apiKey`, a setting's name. */
function configName(key: string): string {
  const words = key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const name = words.map((word, index) => (index ? word[0]!.toUpperCase() + word.slice(1) : word)).join("").replace(/^[0-9]+/, "").slice(0, 60);
  return /^[a-z][a-zA-Z0-9]*$/.test(name) ? name : "setting";
}

/** The parts OhMyGame has no place for, by the files that hold them. */
async function listLeftOut(format: ImportedPluginFormat, manifest: Json, openai: Json, root: string, skipped: PluginImport["skipped"]): Promise<void> {
  const has = async (file: string) => exists(path.join(root, file));
  if (manifest.hooks || openai.hooks || await has("hooks/hooks.json")) skipped.push({ part: "hooks", name: "hooks" });
  // A folder of Skills may have an `agents/` folder of its own; only a Claude plugin's holds subagents.
  if (format === "claude")
    for (const location of locations(manifest.agents, "agents")) {
      const at = await inside(root, location).catch(() => undefined);
      const files = at ? (await isFile(at) ? [at] : await markdownFiles(at)) : [];
      for (const file of files) skipped.push({ part: "agents", name: path.basename(file, ".md") });
    }
  if (manifest.lspServers || await has(".lsp.json")) skipped.push({ part: "lsp", name: "LSP" });
  if (manifest.outputStyles || await has("output-styles")) skipped.push({ part: "output-styles", name: "output-styles" });
  if (manifest.apps || openai.apps || await has(".app.json")) skipped.push({ part: "apps", name: "apps" });
}

async function readJson(root: string, file: string): Promise<Json | undefined> {
  const at = path.join(root, file);
  if (!(await isFile(at))) return undefined;
  try {
    const value: unknown = JSON.parse(await readFile(at, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
  } catch {
    throw new PluginConversionError(`${file} isn't valid JSON`);
  }
}

/** Markdown files in a folder, to any depth, leaving out hidden ones and links. */
async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const at = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownFiles(at)));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(at);
  }
  return found.sort();
}

async function isFile(at: string): Promise<boolean> {
  return (await lstat(at).catch(() => undefined))?.isFile() ?? false;
}

async function exists(at: string): Promise<boolean> {
  return Boolean(await lstat(at).catch(() => undefined));
}

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
