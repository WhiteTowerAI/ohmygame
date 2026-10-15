import { stat } from "node:fs/promises";
import path from "node:path";
import type { PluginDetail } from "../shared/plugins.js";
import { isPluginVersion } from "../shared/plugins.js";
import type {
  PluginDependencyCheck,
  PluginDiagnostics,
} from "../shared/plugin-portability.js";
import type { PluginCapabilities } from "./plugin-capabilities.js";
import { findExecutable, windowsExecutableNames } from "./package-manager.js";

export async function executableExists(
  command: string,
  searchPath = process.env.PATH ?? "",
  cwd = process.cwd(),
): Promise<boolean> {
  const candidates =
    process.platform === "win32"
      ? [command, ...windowsExecutableNames(command, process.env.PATHEXT)]
      : [command];
  const directories =
    command.includes("/") || command.includes("\\")
      ? [cwd]
      : [...searchPath.split(path.delimiter), path.dirname(process.execPath)];
  return Boolean(await findExecutable(candidates, directories));
}

export async function inspectPluginDependencies(
  plugin: PluginDetail,
  capabilities: PluginCapabilities,
): Promise<PluginDiagnostics> {
  const root = await capabilities.packageRoot(plugin);
  const checks: PluginDependencyCheck[] = [];
  const values = capabilities.configuration.view(plugin).values;
  const resolve = (value: string) =>
    value.replace(/\$\{config\.([a-z0-9_.-]+)\}/g, (match, key: string) =>
      Object.hasOwn(values, key) ? String(values[key]) : match,
    );
  const unresolved = (value: string) => value.includes("${config.");
  const absolute = (value: string) =>
    path.isAbsolute(value) || path.win32.isAbsolute(value);
  const commandChecks = new Set<string>();
  const checkCommand = async (
    command: string,
    cwd: string,
    searchPath?: string,
  ) => {
    const key = JSON.stringify([command, cwd, searchPath]);
    if (commandChecks.has(key)) return;
    commandChecks.add(key);
    checks.push({
      code: "command",
      target: path.basename(command),
      status: (await executableExists(command, searchPath, cwd))
        ? "ok"
        : "error",
    });
    if (absolute(command))
      checks.push({
        code: "absolute-path",
        target: path.basename(command),
        status: "warning",
      });
  };
  if (plugin.requirements?.platforms?.length)
    checks.push({
      code: "platform",
      target: plugin.requirements.platforms.join(", "),
      status: plugin.requirements.platforms.includes(
        process.platform as "darwin" | "win32" | "linux",
      )
        ? "ok"
        : "error",
    });
  for (const command of plugin.requirements?.commands ?? [])
    await checkCommand(command, root);
  for (const server of plugin.mcpServers ?? []) {
    const definition = await capabilities.editableTemplate(plugin, server.id);
    if (typeof definition.command !== "string") continue;
    const command = resolve(definition.command);
    const rawCwd =
      typeof definition.cwd === "string" ? resolve(definition.cwd) : ".";
    const env =
      definition.env && typeof definition.env === "object"
        ? (definition.env as Record<string, unknown>)
        : {};
    const searchPath =
      typeof env.PATH === "string" ? resolve(env.PATH) : undefined;
    const args = Array.isArray(definition.args)
      ? definition.args
          .filter((arg): arg is string => typeof arg === "string")
          .map(resolve)
      : [];
    if (/^(npx|bunx)(\.cmd)?$/i.test(path.basename(command))) {
      for (const spec of packageSpecs(args))
        if (!isPluginVersion(spec.slice(spec.lastIndexOf("@") + 1)))
          checks.push({
            code: "unpinned-package",
            target: spec,
            status: "warning",
          });
    }
    if ([command, rawCwd, searchPath ?? ""].some(unresolved)) {
      checks.push({
        code: "configuration",
        target: server.name,
        status: "warning",
      });
      continue;
    }
    const cwd = path.resolve(root, rawCwd);
    if (typeof definition.cwd === "string") {
      let exists = false;
      try {
        exists = (await stat(cwd)).isDirectory();
      } catch {
        /* Report a missing working directory. */
      }
      checks.push({
        code: "cwd",
        target: server.name,
        status: exists ? "ok" : "error",
      });
      if (absolute(rawCwd))
        checks.push({
          code: "absolute-path",
          target: `${server.id}: cwd`,
          status: "warning",
        });
    }
    await checkCommand(command, cwd, searchPath);
    for (const arg of args) {
      if (
        unresolved(arg) ||
        arg.startsWith("-") ||
        /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ||
        !/\.(?:js|mjs|cjs|py|sh)$/i.test(arg)
      )
        continue;
      if (absolute(arg))
        checks.push({
          code: "absolute-path",
          target: `${server.id}: ${path.basename(arg)}`,
          status: "warning",
        });
      let exists = false;
      try {
        exists = (await stat(path.resolve(cwd, arg))).isFile();
      } catch {
        /* Report a missing script. */
      }
      checks.push({
        code: "path",
        target: `${server.id}: ${path.basename(arg)}`,
        status: exists ? "ok" : "error",
      });
    }
  }
  for (const skill of plugin.skills) {
    const content = await capabilities.skillContent(plugin, skill.id);
    if (
      content &&
      /(?:\/(?:Users|home|tmp|private|var)\/|[A-Z]:\\)[^\s]*plugin-setup[\/\\]/i.test(
        content,
      )
    )
      checks.push({
        code: "absolute-path",
        target: skill.name,
        status: "warning",
      });
  }
  return { checks };
}

function packageSpecs(args: string[]): string[] {
  const explicit: string[] = [];
  let positional: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "-p" || arg === "--package") {
      if (args[index + 1]) explicit.push(args[++index]!);
    } else if (arg.startsWith("--package="))
      explicit.push(arg.slice("--package=".length));
    else if (["-c", "--call"].includes(arg)) break;
    else if (
      ["--cache", "--registry", "--userconfig", "--node-options"].includes(arg)
    )
      index++;
    else if (!arg.startsWith("-")) {
      positional = arg;
      break;
    }
  }
  return explicit.length ? explicit : positional ? [positional] : [];
}
