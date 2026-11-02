// Checks a plugin package the way its author wants to hear about it, before
// anyone installs it: `bun run plugin:check <folder>`. First the checks every
// install runs, then its pages against the page components' contract and the
// app's design tokens. An error is something that won't work; a warning is
// something that works now but won't match the app or won't last. Exits with
// 1 when there is an error.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexPluginPackage } from "../src/daemon/plugin-index.js";
import { PAGE_TOKENS } from "../src/shared/plugin-ui-protocol.js";
import { PLUGIN_UI_MAJORS, PLUGIN_UI_PREVIEW_MAJORS, PLUGIN_UI_RETIRING } from "../src/shared/plugin-ui-versions.js";
import { componentManifest, declarations } from "./plugin-ui-contract.js";

export interface PluginCheckFinding {
  level: "error" | "warning";
  /** The file it is in, relative to the package. */
  file?: string;
  message: string;
}

/** Attributes any element takes, so they aren't part of a component's contract. */
const GLOBAL_ATTRIBUTE = /^(?:id|class|slot|style|hidden|title|role|lang|dir|tabindex|part|inert|aria-.+|data-.+|on[a-z]+)$/;
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/;
/** A CSS declaration, so a selector such as `a:not(#top)` isn't read as one. */
const DECLARATION = /(?:^|[{;])\s*([\w-]+)\s*:\s*([^;{}]+)(?=[;}]|$)/g;

/** The pages' files, without what a package manager or Git keeps beside them. */
async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".git" ? Promise.resolve([]) : filesIn(full);
      return Promise.resolve(/\.(?:html|js|mjs|css)$/.test(entry.name) ? [full] : []);
    }),
  );
  return found.flat();
}

/** An HTML tag's attributes by lowercase name, read whole, so `data-src` isn't `src`. */
function attributesOf(text: string): Map<string, string> {
  return new Map([...text.matchAll(/([^\s=/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)].map(([, name, double, single, bare]) => [name!.toLowerCase(), double ?? single ?? bare ?? ""]));
}

const scriptsIn = (html: string) => [...html.matchAll(/<script\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)].map(([, attributes]) => attributesOf(attributes!));

/** The component majors a file really loads: a script's address, not a mention in its text. */
function majorsIn(file: string, text: string): string[] {
  if (file.endsWith(".html")) return scriptsIn(text).flatMap((script) => /^(?:\.\.?\/)*\/?_ohmygame\/ui\/(\d+)\//.exec(script.get("src") ?? "")?.[1] ?? []);
  return [...text.matchAll(/["'`](?:\$\{[^}]*\})?(?:\.\.?\/)*\/?_ohmygame\/ui\/(\d+)\/[^"'`\s]*["'`]/g)].map(([, major]) => major!);
}

/** A file's text without comments, which may name anything. */
function withoutComments(file: string, text: string): string {
  const normal = text.replace(/\r\n/g, "\n");
  if (file.endsWith(".css")) return normal.replace(/\/\*[\s\S]*?\*\//g, "");
  if (file.endsWith(".html")) return normal.replace(/<!--[\s\S]*?-->/g, "");
  return normal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** What a script with no `src` is when it runs; any other type is data, which never does. */
const RUNS = /^(?:|module|importmap|speculationrules|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/;

/** A page's markup, without the elements whose contents are only text. */
const markupOf = (text: string) => text.replace(/<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");

/** Each `<omg-…>` tag in markup, with the names of its attributes. */
function tagsIn(text: string): { tag: string; attributes: string[] }[] {
  return [...text.matchAll(/<(omg-[a-z0-9-]+)((?:"[^"]*"|'[^']*'|\$\{[^}]*\}|[^'">])*)>/g)].map(([, tag, rest]) => ({
    tag: tag!,
    attributes: [...rest!.replace(/"[^"]*"|'[^']*'|\$\{[^}]*\}/g, "").matchAll(/([a-zA-Z_:@][\w:.-]*)/g)].map(([, name]) => name!),
  }));
}

/** Checks a package; `root` is its folder. */
export async function checkPlugin(root: string): Promise<PluginCheckFinding[]> {
  const indexed = await indexPluginPackage(root);
  if (!indexed.ok) return indexed.issues.map((issue) => ({ level: "error", message: `${issue.path} ${issue.message}`.trim() }));
  const findings: PluginCheckFinding[] = [];
  const { manifest } = indexed.entry;
  const panels = manifest.contributes?.panels ?? [];
  if (!panels.length) return findings;

  const majors = new Map(await Promise.all(PLUGIN_UI_MAJORS.map(async (major) => [major, declarations(await componentManifest(major))] as const)));
  // What the app serves for a panel: its folder, or only its page when that is
  // at the package's root, and the package's assets, which a page may load from.
  const relative = (file: string) => path.relative(root, file);
  const panelFiles = await Promise.all(
    panels.map((panel) => {
      const folder = path.dirname(panel.entry);
      return folder === "." ? Promise.resolve([path.join(root, panel.entry)]) : filesIn(path.join(root, folder));
    }),
  );
  const assets = (await filesIn(path.join(root, "assets"))).filter((file) => !file.endsWith(".html"));
  const files = [...new Set([...panelFiles.flat(), ...assets])].sort();
  const sources = await Promise.all(files.map(async (file) => ({ file: relative(file), text: withoutComments(file, await readFile(file, "utf8").catch(() => "")) })));
  const page = sources.filter(({ file }) => /\.(?:html|js|mjs)$/.test(file));
  const add = (level: PluginCheckFinding["level"], file: string, message: string) => findings.push({ level, file, message });

  // Which majors the pages load, by the addresses in them.
  const loaded = new Map<string, string>();
  for (const { file, text } of page) for (const major of majorsIn(file, text)) if (!loaded.has(major)) loaded.set(major, file);
  for (const [major, file] of loaded) {
    if (!majors.has(major)) add("error", file, `Page components ${major} aren't served by this version of OhMyGame`);
    else if (PLUGIN_UI_PREVIEW_MAJORS.has(major)) {
      if (manifest.ui?.preview) add("warning", file, `Page components ${major} are in preview: they can change between releases, and a featured plugin can't use them`);
      else add("error", file, `Page components ${major} are in preview, so they load only with "ui": { "preview": true }`);
    }
    const retiring = PLUGIN_UI_RETIRING[major];
    if (retiring) add("warning", file, `Page components ${major} are served until ${retiring.until}; move to a newer major`);
    if (manifest.ui?.major !== undefined && String(manifest.ui.major) !== major) add("warning", file, `The page loads components ${major}, but ui.major says ${manifest.ui.major}`);
  }
  if (loaded.size && manifest.ui?.major === undefined) add("warning", ".ohmygame-plugin/plugin.json", `Say which components the pages use with "ui": { "major": ${[...loaded.keys()][0]} }, so an app without them can tell the person to update`);

  // What the pages use, against the contracts of the majors they load: a file
  // that names no major may be part of a page with any of them.
  const served = [...loaded.keys()].filter((major) => majors.has(major));
  const contract = (served.length ? served : [String(manifest.ui?.major ?? PLUGIN_UI_MAJORS[0])]).flatMap((major) => majors.get(major) ?? []);
  const contractFor = (file: string, text: string) => {
    const own = majorsIn(file, text);
    return own.length ? own.flatMap((major) => majors.get(major) ?? []) : contract;
  };
  const events = new Set(contract.flatMap((item) => item.events.map((event) => event.name)));
  const parts = new Set(contract.flatMap((item) => item.cssParts.map((part) => part.name)));
  const properties = new Set(contract.flatMap((item) => item.cssProperties.map((property) => property.name)));
  const tokens = new Set<string>([...PAGE_TOKENS, ...properties, "--omg-accent", "--omg-on-accent"]);
  for (const { file, text } of page) {
    const html = file.endsWith(".html");
    if (html) {
      for (const script of scriptsIn(text)) {
        const source = script.get("src");
        const type = (script.get("type") ?? "").trim().toLowerCase();
        if (!source && !RUNS.test(type)) continue;
        if (source && type !== "module" && majorsIn(file, `<script src="${source}">`).length) add("error", file, `${source} is a module, so it loads only with type="module"`);
        if (!source) add("error", file, "The page's policy allows no inline scripts; put the script in a file next to it");
        else if (/^(?:https?:)?\/\//.test(source)) add("error", file, `The page's policy allows no remote scripts: ${source}`);
      }
    }
    if (html)
      for (const [, attributes] of markupOf(text).matchAll(/<[a-zA-Z][^\s/>]*((?:"[^"]*"|'[^']*'|[^'">])*)>/g))
        for (const name of attributesOf(attributes!).keys())
          if (/^on[a-z]+$/.test(name)) add("error", file, `The page's policy allows no inline event handlers: ${name}`);
    if (!html)
      for (const [, address] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]((?:https?:)?\/\/[^"'`]+)["'`]/g))
        add("error", file, `The page's policy allows no remote scripts: ${address}`);
    const known = new Map(contractFor(file, text).map((item) => [item.tagName, item]));
    // Only a page's own markup is sure to be an element; a script may just be
    // saying a name. And a major this app doesn't have can't be checked against.
    const used = new Set<string>();
    const named = new Set<string>();
    if (!known.size) continue;
    for (const { tag, attributes } of tagsIn(html ? markupOf(text) : text)) {
      (html ? used : named).add(tag);
      const item = known.get(tag);
      if (!item) continue;
      const names = new Set(item.attributes.map((attribute) => attribute.name));
      for (const name of attributes) {
        if (!names.has(name) && !GLOBAL_ATTRIBUTE.test(name)) add("warning", file, `<${tag}> has no attribute ${name}`);
        const reason = item.attributes.find((attribute) => attribute.name === name)?.deprecated;
        if (reason) add("warning", file, `<${tag}>'s ${name} is deprecated: ${reason}`);
      }
    }
    // They also name components as strings, along with their events.
    if (!html) for (const [, name] of text.matchAll(/["'`](omg-[a-z0-9-]+)["'`]/g)) if (!events.has(name!)) named.add(name!);
    for (const tag of [...used, ...named]) {
      const item = known.get(tag);
      if (!item) add(used.has(tag) ? "error" : "warning", file, `There is no component <${tag}>`);
      else if (item.deprecated) add("warning", file, `<${tag}> is deprecated: ${item.deprecated}`);
    }
  }

  // Each page loads the components itself, as another page's don't reach it: by
  // a script tag, or from one of its own scripts if one of those it can reach
  // loads them. An address a script puts together loads a major this can't name.
  const missing = new Set<string>();
  for (const own of panelFiles) {
    const reach = new Set([...own, ...assets].map(relative));
    const reached = page.filter(({ file }) => reach.has(file));
    const scriptLoads = reached.some(({ file, text }) => !file.endsWith(".html") && text.includes("/_ohmygame/ui/"));
    for (const { file, text } of reached) {
      if (!file.endsWith(".html") || !/<omg-[a-z]/.test(markupOf(text)) || majorsIn(file, text).length) continue;
      if (!scriptLoads || !scriptsIn(text).some((script) => script.get("src"))) missing.add(file);
    }
  }
  for (const file of missing) add("error", file, "The page uses page components but no script loads /_ohmygame/ui/<major>/index.js");

  // Styles keep to the app's tokens, so a page follows its themes.
  for (const { file, text } of sources.filter((source) => source.file.endsWith(".css") || source.file.endsWith(".html"))) {
    const css = file.endsWith(".css") ? text : [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(([, body]) => body!).join("\n");
    const own = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name!));
    const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, property, value] of body.matchAll(DECLARATION))
      if (COLOR.test(value!.replace(/url\([^)]*\)/g, "")) && !property!.startsWith("--")) add("warning", file, `${property}: ${value!.trim()} is a fixed colour, so it won't follow the app's themes; use a colour token`);
    for (const name of new Set([...body.matchAll(/var\(\s*(--[\w-]+)/g)].map(([, name]) => name!)))
      if (!tokens.has(name) && !own.has(name)) add("warning", file, `${name} isn't one of the app's tokens`);
    for (const name of new Set([...body.matchAll(/::part\(\s*([\w-]+)\s*\)/g)].map(([, name]) => name!)))
      if (!parts.has(name)) add("warning", file, `No component has a part named ${name}`);
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2];
  if (!folder) {
    console.error("Usage: bun run plugin:check <folder>");
    process.exit(2);
  }
  const findings = await checkPlugin(path.resolve(folder));
  for (const { level, file, message } of findings) console[level === "error" ? "error" : "log"](`${level}: ${file ? `${file}: ` : ""}${message}`);
  const errors = findings.filter((finding) => finding.level === "error").length;
  console.log(findings.length ? `${errors} errors, ${findings.length - errors} warnings` : "No problems found");
  if (errors) process.exit(1);
}
