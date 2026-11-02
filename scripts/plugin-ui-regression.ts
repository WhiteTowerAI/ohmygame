// Loads plugins' panels against the page components, in the Chromium the app
// ships: `bun run plugin-ui:regression [--base <git ref>] [--out <folder>] [plugin folders]`.
// Each panel opens in both appearances and is checked for errors in its console
// and components that never registered, and a picture is kept. With --base it
// runs again on that ref's components, on this machine, so fonts don't count:
// what fails is only what is newly wrong, and pictures that changed are listed
// without failing, as a change in how things look isn't a break. With no folders
// it runs the plugins this repository has. Commands don't run, so every panel
// shows how it takes that; plugin-ui-regression-scenarios.json gives a plugin's
// commands results, so its panel shows other states too.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, appendFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PluginIndex, type PluginIndexEntry } from "../src/daemon/plugin-index.js";
import { startPluginUiServer } from "../src/daemon/plugin-ui-server.js";
import { accentTokens, PAGE_TOKENS, PLUGIN_UI_HANDSHAKE, PLUGIN_UI_PROTOCOL_VERSION, pluginUiRefusal, readPluginUiRequest, type PluginAccent, type PluginUiCapabilities } from "../src/shared/plugin-ui-protocol.js";

const DEFAULT_PLUGINS = ["packages/plugin-ui/gallery", "plugins/taptap-maker"];
const APPEARANCES = ["dark", "light"] as const;

/** One panel in one appearance, as the browser found it. */
export interface PanelRun {
  plugin: string;
  panel: string;
  /** Which results its commands had; none means they all failed. */
  scenario?: string;
  appearance: string;
  /** What is wrong with it, with addresses that don't differ between runs. */
  issues: string[];
  /** Whether its page connected to the app, which a page needn't do. */
  connected?: boolean;
  /** The picture's file, and its SHA-256, so equal pictures compare equal. */
  file?: string;
  picture?: string;
}

/** What makes `head` worse than `base`, and which pictures differ. */
export function compareRuns(base: readonly PanelRun[] | undefined, head: readonly PanelRun[]): { failures: string[]; changed: string[] } {
  const name = (run: PanelRun) => `${run.plugin} ${run.panel}${run.scenario ? ` ${run.scenario}` : ""} (${run.appearance})`;
  const failures: string[] = [];
  const changed: string[] = [];
  for (const run of head) {
    const before = base?.find((other) => name(other) === name(run));
    for (const issue of run.issues) if (!before?.issues.includes(issue)) failures.push(`${name(run)}: ${issue}`);
    if (before?.connected && !run.connected) failures.push(`${name(run)}: the page no longer connects to the app`);
    if (before && before.picture !== run.picture) changed.push(name(run));
  }
  return { failures, changed };
}

/** What a person who allowed everything the plugin asks for gives its pages. */
function capabilitiesOf(entry: PluginIndexEntry): PluginUiCapabilities {
  const asked = entry.manifest.capabilities;
  return { "project.selection": asked?.["project.selection"] === true, composer: asked?.composer === true };
}

/** The page the panel loads in: the app's frame, its tokens and its answers, with nothing behind them. */
const harness = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css">
<style>html, body { height: 100%; margin: 0; background: var(--color-surface); } iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }</style>
</head><body><iframe sandbox="allow-scripts"></iframe><script>
const query = new URLSearchParams(location.search);
const appearance = query.get("appearance");
const results = JSON.parse(query.get("results") || "null");
const capabilities = JSON.parse(query.get("capabilities") || "{}");
const stored = new Map();
document.documentElement.dataset.appearance = appearance;
const frame = document.querySelector("iframe");
frame.addEventListener("load", async () => {
  const style = getComputedStyle(document.documentElement);
  const tokens = {};
  for (const token of ${JSON.stringify(PAGE_TOKENS)}) {
    const value = style.getPropertyValue(token).trim();
    if (value) tokens[token] = value;
  }
  const theme = await (await fetch("/theme", { method: "POST", body: JSON.stringify({ tokens, appearance, accent: JSON.parse(query.get("accent") || "null") }) })).json();
  const channel = new MessageChannel();
  const answers = {
    "theme.get": () => ({ tokens: theme.tokens, appearance }),
    "project.info": () => ({ name: "Regression check", type: "general" }),
    "storage.get": ({ key }) => stored.get(key) ?? null,
    "storage.set": ({ key, value }) => { stored.set(key, value); return null; },
    "command.run": ({ command }) => {
      if (results && command in results) return results[command];
      throw new Error("Commands don't run in this check");
    },
    "ui.confirm": () => false,
  };
  channel.port1.onmessage = async ({ data }) => {
    if (data?.event === "ready") { window.pluginReady = true; return; }
    // The app's own checks, so a page is refused here what it would be refused there.
    const checked = await (await fetch("/check", { method: "POST", body: JSON.stringify({ data, capabilities }) })).json();
    if (checked.error) {
      if (checked.id !== undefined) channel.port1.postMessage({ id: checked.id, error: checked.error });
      return;
    }
    try {
      channel.port1.postMessage({ id: data.id, result: answers[data.method]?.(data.params ?? {}) ?? null });
    } catch (error) {
      channel.port1.postMessage({ id: data.id, error: error.message });
    }
  };
  frame.contentWindow.postMessage({
    type: ${JSON.stringify(PLUGIN_UI_HANDSHAKE)},
    protocol: ${PLUGIN_UI_PROTOCOL_VERSION},
    plugin: { id: query.get("plugin"), version: query.get("version"), panel: query.get("panel") },
    locale: "en",
    theme: { event: "theme", ...theme },
  }, "*", [channel.port2]);
}, { once: true });
frame.src = query.get("src");
</script></body></html>`;

/** Copies a ref's components, the package's only part a run on it changes. */
function componentsAt(ref: string, directory: string): Promise<unknown[]> {
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "packages/plugin-ui"], { encoding: "utf8" }).split("\n").filter(Boolean);
  return Promise.all(
    files.map(async (file) => {
      const target = path.join(directory, path.relative("packages/plugin-ui", file));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, execFileSync("git", ["show", `${ref}:${file}`], { maxBuffer: 64 * 1024 * 1024 }));
    }),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args.splice(at, 2)[1];
  };
  const base = option("--base");
  const out = path.resolve(option("--out") ?? path.join(".runtime", "plugin-ui-regression"));
  const folders = args.length ? args : DEFAULT_PLUGINS;
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const work = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-ui-regression-"));
  const index = new PluginIndex(path.join(work, "index.json"));
  await index.load();
  const entries: PluginIndexEntry[] = [];
  for (const folder of folders) {
    const added = await index.add(path.resolve(folder));
    if (!added.ok) throw new Error(`${folder}: ${added.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    entries.push(added.entry);
  }

  const scenarios = JSON.parse(await readFile(path.join(import.meta.dirname, "plugin-ui-regression-scenarios.json"), "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
  const tokensCss = await readFile("src/renderer/ui/tokens.css");
  const host = createServer((request, response) => {
    if (request.url?.startsWith("/harness.html")) return void response.writeHead(200, { "content-type": "text/html" }).end(harness);
    if (request.url === "/tokens.css") return void response.writeHead(200, { "content-type": "text/css" }).end(tokensCss);
    if (request.url === "/check" && request.method === "POST") {
      const parts: Buffer[] = [];
      request.on("data", (part: Buffer) => parts.push(part));
      request.on("end", () => {
        const { data, capabilities } = JSON.parse(Buffer.concat(parts).toString()) as { data: unknown; capabilities: PluginUiCapabilities };
        const read = readPluginUiRequest(data);
        const answer = read.ok ? { error: pluginUiRefusal(read.request.method, capabilities), id: read.request.id } : { error: read.error, id: read.id };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
      });
      return;
    }
    if (request.url === "/theme" && request.method === "POST") {
      const parts: Buffer[] = [];
      request.on("data", (part: Buffer) => parts.push(part));
      request.on("end", () => {
        const { tokens, appearance, accent } = JSON.parse(Buffer.concat(parts).toString()) as { tokens: Record<string, string>; appearance: "dark" | "light"; accent?: PluginAccent };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tokens: { ...tokens, ...accentTokens(accent ?? undefined, appearance, tokens) }, appearance }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const hostOrigin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;

  /** Runs every panel on the components in `sdkDirectory`. */
  async function run(label: string, sdkDirectory: string): Promise<PanelRun[]> {
    const server = await startPluginUiServer({ index, sdkDirectory, frameAncestors: [hostOrigin] });
    try {
      const jobs = entries.flatMap((entry) =>
        (entry.manifest.contributes?.panels ?? []).flatMap((panel) =>
          [undefined, ...Object.keys(scenarios[entry.id] ?? {})].flatMap((scenario) =>
            APPEARANCES.map((appearance) => {
              const query = new URLSearchParams({ src: server.panelUrl(entry.id, entry.version, panel.id)!, plugin: entry.id, version: entry.version, panel: panel.id, appearance, accent: JSON.stringify(entry.manifest.ui?.accent ?? null), capabilities: JSON.stringify(capabilitiesOf(entry)), results: JSON.stringify(scenario ? scenarios[entry.id]![scenario] : null) });
              const view = [entry.id.replace("/", "-"), panel.id, scenario, appearance].filter(Boolean).join("-");
              return { plugin: entry.id, panel: panel.id, ...(scenario ? { scenario } : {}), appearance, url: `${hostOrigin}/harness.html?${query}`, file: path.join(out, `${view}.${label}.png`) };
            }),
          ),
        ),
      );
      const jobFile = path.join(work, `${label}.json`);
      const resultFile = path.join(work, `${label}-results.json`);
      await writeFile(jobFile, JSON.stringify({ jobs, origins: [hostOrigin, server.url], profile: path.join(work, `profile-${label}`) }));
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const electron = createRequire(import.meta.url)("electron") as unknown as string;
      const child = spawn(electron, [path.join(import.meta.dirname, "plugin-ui-regression-browser.cjs"), jobFile, resultFile], { stdio: "inherit", env: environment });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (exit, signal) => resolve(exit ?? (signal ? 1 : 0)));
      });
      if (code !== 0) throw new Error(`The browser exited with ${String(code)}`);
      const runs = JSON.parse(await readFile(resultFile, "utf8")) as PanelRun[];
      return await Promise.all(runs.map(async (panelRun) => ({ ...panelRun, picture: panelRun.file ? createHash("sha256").update(await readFile(panelRun.file)).digest("hex") : undefined })));
    } finally {
      await server.close();
    }
  }

  let baseRuns: PanelRun[] | undefined;
  try {
    if (base) {
      const directory = path.join(work, "base");
      await componentsAt(base, directory);
      baseRuns = await run("base", directory);
    }
    const headRuns = await run("head", path.resolve("packages/plugin-ui"));
    const { failures, changed } = compareRuns(baseRuns, headRuns);
    const lines = [
      `Checked ${headRuns.length} panel views from ${entries.length} plugins${base ? `, against the components at ${base}` : ""}. Pictures are in ${out}.`,
      ...(base ? [changed.length ? `These look different from ${base}, which doesn't fail the check:` : `Nothing looks different from ${base}.`, ...changed.map((name) => `- ${name}`)] : []),
    ];
    console.log(lines.join("\n"));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Page components on plugins' panels\n\n${[...lines, ...failures.map((failure) => `- ${failure}`)].join("\n")}\n`);
    for (const failure of failures) console.error(failure);
    if (failures.length) process.exitCode = 1;
  } finally {
    await new Promise((resolve) => host.close(resolve));
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
