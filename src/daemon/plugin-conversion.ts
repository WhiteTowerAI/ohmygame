// From format 1 to format 2. A format 1 plugin that only adds Skills becomes a
// format 2 package (bundled plugins, by script, in place; any other format 1
// package's Skills, by `convertFormat1Package`, into a new folder).
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginCategory } from "../shared/plugin-manifest.js";
import type { PluginManifest, ResolvedPluginManifest } from "../shared/plugins.js";
import { indexPluginPackage, type PluginIndexEntry } from "./plugin-index.js";
import { Document, isMap, parseDocument } from "yaml";
import { parseSkillMetadata } from "./skill-metadata.js";

export interface ConvertedPlugin {
  /** `.ohmygame-plugin/plugin.json`. */
  manifest: Record<string, unknown>;
  /** `locales/en.json`: the manifest's display strings. */
  strings: Record<string, string>;
}

/**
 * Format 2 manifest and strings for a format 1 plugin that only adds Skills.
 * Its Skills folder and icon keep their paths, so the files copy as they are.
 */
export function convertFormat1Manifest(
  manifest: PluginManifest,
  { publisher, categories }: { publisher: string; categories?: PluginCategory[] },
): ConvertedPlugin {
  const unsupported = (["mcpServers", "configuration", "connections", "requirements"] as const).filter((key) => manifest[key] !== undefined);
  if (unsupported.length) throw new Error(`${manifest.name} has ${unsupported.join(", ")}; only plugins that add Skills convert`);
  if (typeof manifest.skills !== "string") throw new Error(`${manifest.name} must keep its Skills in one folder`);
  const face = manifest.interface ?? {};
  const strings: Record<string, string> = {
    displayName: face.displayName ?? manifest.name,
    description: face.shortDescription ?? manifest.description,
  };
  if (face.longDescription) strings.longDescription = face.longDescription;
  const examples = (face.defaultPrompt ?? []).slice(0, 5);
  examples.forEach((prompt, index) => (strings[`example.${index + 1}`] = prompt));
  const icon = face.icon?.type === "asset" ? face.icon.path : undefined;
  return {
    manifest: {
      $schema: "https://ohmygame.dev/schema/plugin-2.json",
      id: `${publisher}/${manifest.name}`,
      version: manifest.version,
      engines: { "ohmygame-api": "^2.0.0" },
      displayName: "%displayName%",
      description: "%description%",
      ...(strings.longDescription ? { longDescription: "%longDescription%" } : {}),
      ...(examples.length ? { examples: examples.map((_, index) => `%example.${index + 1}%`) } : {}),
      ...(face.beta ? { beta: true } : {}),
      ...(icon ? { icon } : {}),
      ...(categories?.length ? { categories } : {}),
      ...(face.projectTypes?.length ? { appliesTo: face.projectTypes } : {}),
      contributes: { skills: manifest.skills },
    },
    strings,
  };
}

/** What a format 1 package has besides Skills; `convertFormat1Package` leaves it to the caller. */
const NOT_SKILLS = ["mcpServers", "configuration", "connections", "requirements"] as const;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ConvertedPackage {
  entry: PluginIndexEntry;
  /** Each Skill's old path in the format 1 package to its new one, both `a/b/SKILL.md`. */
  skills: Record<string, string>;
  /** Parts of the format 1 manifest not carried over (MCP servers, configuration, …). */
  left: string[];
  /** What changed besides the layout, for the person or a log. */
  notes: string[];
}

export class PluginConversionError extends Error {}

/**
 * Writes a format 2 package for a format 1 package's Skills into `target`,
 * a folder that doesn't exist yet:
 * - every `SKILL.md` its Skills paths reach (a folder, searched to any depth,
 *   or one `SKILL.md`; one path or several) becomes `skills/<name>/`, its
 *   folder copied with it, minus Skills nested inside, which get their own;
 * - a Skill's name is its frontmatter name made a folder name, numbered when
 *   two match, and its frontmatter says that name (and the plugin's
 *   description when it had none);
 * - a file a `SKILL.md` links to outside its folder is copied into its
 *   `_shared/` folder and the link points there;
 * - the icon keeps its path, a missing version is `0.0.0`.
 * The package is checked before this returns. The source is only read.
 */
export async function convertFormat1Package(
  source: { root: string; manifest: PluginManifest | ResolvedPluginManifest },
  target: string,
  { id, categories }: { id: string; categories?: PluginCategory[] },
): Promise<ConvertedPackage> {
  // The real folder, so a link anywhere on a path can't lead outside it.
  const root = await realpath(path.resolve(source.root)).catch(() => {
    throw new PluginConversionError(`${source.root} doesn't exist`);
  });
  const parent = await realpath(path.dirname(path.resolve(target))).catch(() => {
    throw new PluginConversionError(`${path.dirname(target)} doesn't exist`);
  });
  const output = path.join(parent, path.basename(target));
  if (isWithin(root, output) || isWithin(output, root))
    throw new PluginConversionError("The converted package can't be written inside the package it comes from");
  const declared = [source.manifest.skills ?? []].flat().filter((item): item is string => typeof item === "string");
  if (!declared.length) throw new PluginConversionError(`${source.manifest.name} has no Skills to convert`);
  const folders = new Set<string>();
  for (const item of declared) {
    const at = await inside(root, item);
    const stats = await lstat(at).catch(() => undefined);
    if (!stats) throw new PluginConversionError(`${item} is not in the package`);
    if (stats.isFile()) {
      if (path.basename(at) !== "SKILL.md") throw new PluginConversionError(`${item} must be a folder or SKILL.md`);
      folders.add(path.dirname(at));
    } else for (const folder of await skillFolders(at)) folders.add(folder);
  }
  if (!folders.size) throw new PluginConversionError(`${source.manifest.name}'s Skills paths hold no SKILL.md`);

  const left = NOT_SKILLS.filter((key) => source.manifest[key] !== undefined);
  const notes: string[] = left.map((key) => `${key} is not part of the converted package`);
  const ordered = [...folders].sort();
  // Names first, so a link into another Skill's folder can follow it.
  const named = new Map<string, { name: string; text: string; description?: string }>();
  const names = new Set<string>();
  for (const folder of ordered) {
    const text = await readFile(path.join(folder, "SKILL.md"), "utf8");
    const metadata = (() => {
      try {
        return parseSkillMetadata(text);
      } catch {
        throw new PluginConversionError(`${posix(path.relative(root, folder), "SKILL.md")} has frontmatter that isn't valid YAML`);
      }
    })();
    const base = skillName(metadata.name) ?? skillName(path.basename(folder)) ?? "skill";
    let name = base;
    for (let index = 2; names.has(name); index++) name = `${base}-${index}`;
    names.add(name);
    if (metadata.name && metadata.name !== name) notes.push(`Skill "${metadata.name}" is named ${name}`);
    named.set(folder, { name, text, ...(metadata.description ? { description: metadata.description } : {}) });
  }
  const skills: Record<string, string> = {};
  await mkdir(output);
  for (const folder of ordered) {
    const { name, text, description } = named.get(folder)!;
    const destination = path.join(output, "skills", name);
    const nested = ordered.filter((other) => other !== folder && isWithin(folder, other));
    await copyFolder(folder, destination, nested);
    const linked = await copyLinked(text, { root, folder, destination, named });
    notes.push(...linked.notes);
    await writeFile(path.join(destination, "SKILL.md"), frontmatter(linked.text, name, description ? undefined : source.manifest.description));
    skills[posix(path.relative(root, folder), "SKILL.md")] = `skills/${name}/SKILL.md`;
  }

  const converted = convertFormat1Manifest(
    {
      ...(Object.fromEntries(Object.entries(source.manifest).filter(([key]) => !(NOT_SKILLS as readonly string[]).includes(key))) as PluginManifest),
      version: source.manifest.version ?? "0.0.0",
      skills: "./skills/",
    },
    { publisher: id.slice(0, id.indexOf("/")), ...(categories ? { categories } : {}) },
  );
  converted.manifest.id = id;
  const icon = typeof converted.manifest.icon === "string" ? converted.manifest.icon : undefined;
  if (icon) {
    const from = await inside(root, icon).catch(() => undefined);
    const stats = from ? await lstat(from).catch(() => undefined) : undefined;
    if (from && stats?.isFile()) {
      // At its path inside the package, however the manifest spelled it, unless
      // a Skill's file landed there; then beside the manifest folder.
      let relative = posix(path.relative(root, from));
      if (await lstat(path.join(output, relative)).then(() => true, () => false)) relative = `icon${path.extname(from)}`;
      converted.manifest.icon = `./${relative}`;
      await mkdir(path.dirname(path.join(output, relative)), { recursive: true });
      await copyFile(from, path.join(output, relative));
    } else {
      delete converted.manifest.icon;
      notes.push(`The icon ${icon} is missing`);
    }
  }
  await mkdir(path.join(output, ".ohmygame-plugin"), { recursive: true });
  await writeFile(path.join(output, ".ohmygame-plugin", "plugin.json"), `${JSON.stringify(converted.manifest, null, 2)}\n`);
  await mkdir(path.join(output, "locales"), { recursive: true });
  await writeFile(path.join(output, "locales", "en.json"), `${JSON.stringify(converted.strings, null, 2)}\n`);
  const checked = await indexPluginPackage(output);
  if (!checked.ok)
    throw new PluginConversionError(`The converted package isn't valid: ${checked.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  return { entry: checked.entry, skills, left: [...left], notes };
}

/** A path the manifest or a Skill names, inside the real package folder through no link. */
async function inside(root: string, relative: string): Promise<string> {
  const at = path.resolve(root, relative);
  if (!isWithin(root, at)) throw new PluginConversionError(`${relative} is outside the package`);
  if (path.relative(root, at).split(path.sep).some(skipped)) throw new PluginConversionError(`${relative} is hidden or installed dependencies`);
  // Every folder on the way, and the path itself, is what it says.
  let current = root;
  for (const part of path.relative(root, at).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stats = await lstat(current).catch(() => undefined);
    if (!stats) break;
    if (stats.isSymbolicLink()) throw new PluginConversionError(`${relative} is a link`);
  }
  return at;
}

function isWithin(root: string, at: string): boolean {
  const relative = path.relative(root, at);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function posix(...parts: string[]): string {
  return parts.filter(Boolean).join("/").split(path.sep).join("/");
}

/** Markdown character references: the named ones a path would use, and numeric ones. */
function entities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (whole, decimal?: string, hex?: string, name?: string) => {
    const code = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : undefined;
    if (code !== undefined) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    return named[name!.toLowerCase()] ?? whole;
  });
}

/** A relative path as a link destination: each name escaped, the separators kept. */
function encodePath(value: string): string {
  return value.split("/").map((part) => (part === ".." || part === "." ? part : encodeURIComponent(part))).join("/");
}

function skillName(value: string | undefined): string | undefined {
  const name = value?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return name && SKILL_NAME.test(name) ? name : undefined;
}

/** Hidden files and folders, and installed dependencies, aren't part of a Skill. */
function skipped(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

async function skillFolders(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new PluginConversionError(`${entry.name} is a link`);
    if (entry.isDirectory()) found.push(...(await skillFolders(path.join(directory, entry.name))));
    else if (entry.isFile() && entry.name === "SKILL.md") found.push(directory);
  }
  return found;
}

async function copyFolder(from: string, to: string, skip: readonly string[]): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const at = path.join(from, entry.name);
    if (skipped(entry.name) || skip.includes(at)) continue;
    if (entry.isSymbolicLink()) throw new PluginConversionError(`${entry.name} is a link`);
    if (entry.isDirectory()) await copyFolder(at, path.join(to, entry.name), skip);
    else if (entry.isFile()) await copyFile(at, path.join(to, entry.name));
  }
}

/**
 * Points `SKILL.md`'s links where their files are now: into another Skill's
 * new folder, or, for a file in no Skill's folder, a copy in `_shared/`.
 */
async function copyLinked(text: string, { root, folder, destination, named }: {
  root: string;
  folder: string;
  destination: string;
  named: ReadonlyMap<string, { name: string }>;
}) {
  const notes: string[] = [];
  const copied = new Map<string, string>();
  // Where each link's destination sits in the original text, and what it becomes.
  const replacements: Array<{ start: number; end: number; to: string }> = [];
  const destinations = [
    // Inline: `[text](dest)` or `(<dest with spaces>)`, with an optional "title", 'title' or (title).
    ...text.matchAll(/\]\(\s*(?:<([^>\n]+)>|((?:\\[()]|[^()\s<>]|\([^()\s<>]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/dg),
    // Reference definitions: `[label]: dest` or `[label]: <dest>`, the destination maybe on the next line.
    ...text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(?:\r?\n[ \t]*)?(?:<([^>\n]+)>|([^\s<>]+))/dgm),
  ];
  // Copies go in `_shared/`, or the next free name when the Skill has its own `_shared/`.
  let sharedRoot: string | undefined;
  const sharedFolder = async () => {
    if (sharedRoot) return sharedRoot;
    let name = "_shared";
    for (let index = 2; await lstat(path.join(destination, name)).then(() => true, () => false); index++) name = `_shared-${index}`;
    return (sharedRoot = name);
  };
  // Examples in code blocks and code spans stay as they are written.
  const code = [...text.matchAll(/^ {0,3}(([`~])\2{2,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1\2*[ \t]*$|(?![\s\S]))|`+[^`\n]+`+/gm)]
    .map((block) => [block.index, block.index + block[0].length] as const);
  for (const match of destinations) {
    if (code.some(([from, to]) => match.index >= from && match.index < to)) continue;
    const group = match[1] !== undefined ? 1 : 2;
    // Character references first: `&amp;` in a destination is `&`.
    const link = entities(match[group]!);
    const [start, end] = match.indices![group]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("#") || link.startsWith("/")) continue;
    const [file, anchor = ""] = link.split(/(?=#)/);
    // Each name decoded on its own, so an escaped `#` or `/` is part of the name.
    let decoded: string;
    try {
      // Markdown's backslash escapes first, then URI escapes.
      // A `%` that starts no escape is a `%` in the name.
      decoded = file!.replace(/\\([!-/:-@[-`{-~])/g, "$1").split("/")
        .map((part) => part.replace(/(?:%[0-9A-Fa-f]{2})+/g, (escaped) => {
          try {
            return decodeURIComponent(escaped);
          } catch {
            return escaped;
          }
        }))
        .join("/");
    } catch {
      continue;
    }
    const at = path.resolve(folder, decoded);
    if (!isWithin(root, at)) continue;
    // The Skill whose folder holds it: the deepest one, as nested Skills get their own.
    const owner = [...named.keys()].filter((candidate) => isWithin(candidate, at)).sort((a, b) => b.length - a.length)[0];
    if (owner) {
      const relative = posix(path.relative(owner, at));
      const pointed = owner === folder ? relative || "." : posix("..", named.get(owner)!.name, relative);
      // Rewritten unless it already says that; one through `..` would name the old folders.
      if (owner !== folder || decoded.split(/[\\/]/).includes(".."))
        replacements.push({ start, end, to: `${encodePath(pointed)}${anchor}` });
      continue;
    }
    const resolved = await inside(root, path.relative(root, at)).catch(() => undefined);
    if (!resolved) continue;
    const stats = await lstat(at).catch(() => undefined);
    if (!stats || stats.isSymbolicLink()) continue;
    let shared = copied.get(at);
    if (!shared) {
      shared = posix(await sharedFolder(), path.relative(root, at));
      if (stats.isDirectory()) await copyFolder(at, path.join(destination, shared), []);
      else if (stats.isFile()) {
        await mkdir(path.dirname(path.join(destination, shared)), { recursive: true });
        await copyFile(at, path.join(destination, shared));
      } else continue;
      copied.set(at, shared);
      notes.push(`${posix(path.relative(root, at))} is copied into the Skill`);
    }
    replacements.push({ start, end, to: `${encodePath(shared)}${anchor}` });
  }
  // One pass over the original text, so a rewritten link is never rewritten again.
  let result = "";
  let at = 0;
  for (const { start, end, to } of replacements.sort((a, b) => a.start - b.start)) {
    if (start < at) continue;
    result += text.slice(at, start) + to;
    at = end;
  }
  return { text: result + text.slice(at), notes };
}

/** `SKILL.md` with its frontmatter naming the Skill as its folder is named, and a description. */
function frontmatter(text: string, name: string, description: string | undefined): string {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/.exec(text);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  // Through the YAML structure, so block scalars and quoted keys stay valid.
  const parsed = match ? parseDocument(match[1]!) : undefined;
  const document = parsed && isMap(parsed.contents) ? parsed : new Document({});
  document.set("name", name);
  if (description !== undefined) document.set("description", description);
  const yaml = document.toString({ lineWidth: 0 }).replace(/\n$/, "").split("\n").join(newline);
  const body = match ? text.slice(match[0].length) : text;
  return `---${newline}${yaml}${newline}---${newline}${body}`;
}
