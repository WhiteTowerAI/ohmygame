import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRuntimeId } from "../../shared/agent-runtimes.js";

/**
 * Variables a coding agent CLI may inherit. The environment is built from
 * this list instead of copied, so the daemon's token, unrelated secrets and,
 * above all, API keys that would silently move the CLI from the person's
 * subscription to metered billing stay out.
 */
const SHARED = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Windows needs these to find the profile, the shell and its programs.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
]);

/** Each CLI's own sign-in and configuration location, which it needs to find the person's subscription. */
const RUNTIME_KEEP: Record<AgentRuntimeId, readonly string[]> = {
  "claude-code-cli": ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"],
  "codex-cli": ["CODEX_HOME"],
  "opencode-cli": [],
};

export function agentEnvironment(
  runtime: AgentRuntimeId,
  binaryPath: string,
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
  shellPath?: string,
): Record<string, string> {
  const keep = new Set([...SHARED, ...RUNTIME_KEEP[runtime]]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (keep.has(name) || keep.has(upper) || upper.startsWith("LC_"))
      result[name] = value;
  }
  const pathKey =
    Object.keys(result).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  // The CLI's own folder comes first: a CLI installed with npm runs under the node next to it.
  result[pathKey] = uniquePath([
    path.dirname(binaryPath),
    ...(shellPath ? [shellPath] : []),
    result[pathKey] ?? "",
    ...commonBinaryDirectories(),
  ]);
  return { ...result, ...extra };
}

/** Where people usually install these CLIs, for an app started from the Dock with only the system PATH. */
export function commonBinaryDirectories(home = os.homedir()): string[] {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    const local = process.env.LOCALAPPDATA;
    return [
      ...(appData ? [path.join(appData, "npm")] : []),
      ...(local
        ? [
            path.join(local, "Programs", "claude"),
            path.join(local, "Microsoft", "WinGet", "Links"),
          ]
        : []),
      path.join(home, ".local", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".opencode", "bin"),
    ];
  }
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

let shellPath: Promise<string | undefined> | undefined;

/**
 * The PATH a login shell sets up, which an app started from the Dock does not
 * get. Read once, with a short limit, between markers so that whatever the
 * shell's startup files print is ignored.
 */
export function loginShellPath(): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return (shellPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    const marker = "__OHMYGAME_PATH__";
    execFile(
      shell,
      ["-ilc", `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`],
      {
        timeout: 4_000,
        encoding: "utf8",
        env: { HOME: os.homedir(), SHELL: shell, TERM: "dumb" },
      },
      (error, stdout) => {
        const match =
          !error || stdout
            ? stdout.match(new RegExp(`${marker}(.*)${marker}`))
            : null;
        resolve(match?.[1] || undefined);
      },
    );
  }));
}

/**
 * Folders a sandboxed command must read to run the person's own toolchains:
 * each folder on the child's PATH and the installation it belongs to, such as
 * an fnm or nvm Node, Homebrew or Bun, so node, npm and git start. A shared
 * folder like ~/.local/bin grants only the installations its programs link
 * to, never the rest of the folder above it, and the home folder itself is
 * never granted. On macOS the command-line developer tools behind the
 * /usr/bin shims (git, python3, make) are readable too.
 */
export function toolchainRoots(
  pathValue: string,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const shared = new Set([path.join(home, ".local"), "/"]);
  const roots = new Set<string>();
  const installation = (target: string) => {
    const folder = path.dirname(target);
    return path.basename(folder) === "bin" ? path.dirname(folder) : folder;
  };
  for (const entry of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    let folder: string;
    try {
      folder = realpathSync(entry);
    } catch {
      continue;
    }
    if (folder === home || folder === "/") continue;
    roots.add(folder);
    if (path.basename(folder) !== "bin") continue;
    const prefix = path.dirname(folder);
    if (prefix !== home && !shared.has(prefix)) {
      roots.add(prefix);
      continue;
    }
    let names: string[] = [];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const target = realpathSync(path.join(folder, name));
        if (!target.startsWith(`${folder}${path.sep}`)) {
          const linked = installation(target);
          if (linked !== home && !shared.has(linked)) roots.add(linked);
        }
      } catch {
        /* A dangling link runs nothing. */
      }
    }
  }
  if (platform === "darwin")
    for (const developer of [
      "/Library/Developer/CommandLineTools",
      "/Applications/Xcode.app",
    ])
      if (existsSync(developer)) roots.add(developer);
  return [...roots];
}

/**
 * Package caches kept in a session's temporary folder: the home folder's
 * caches are outside the folders a sandboxed command may write.
 */
export function sessionCaches(temporary: string): Record<string, string> {
  return {
    XDG_CACHE_HOME: path.join(temporary, "cache"),
    npm_config_cache: path.join(temporary, "npm-cache"),
    BUN_INSTALL_CACHE_DIR: path.join(temporary, "bun-cache"),
    YARN_CACHE_FOLDER: path.join(temporary, "yarn-cache"),
  };
}

/**
 * The PATH for sandboxed commands. On macOS the /usr/bin shims for git,
 * python3 and make go through xcrun, which writes a cache to the system
 * temporary folder that a sandbox does not let commands write; the
 * command-line tools' own programs come just before them, so anything the
 * person installed earlier on PATH still wins.
 */
export function sandboxedPath(
  pathValue: string,
  platform: NodeJS.Platform = process.platform,
  developer = "/Library/Developer/CommandLineTools/usr/bin",
): string {
  if (platform !== "darwin" || !existsSync(developer)) return pathValue;
  const parts = pathValue
    .split(path.delimiter)
    .filter((part) => part !== developer);
  const shims = parts.indexOf("/usr/bin");
  parts.splice(shims < 0 ? parts.length : shims, 0, developer);
  return parts.join(path.delimiter);
}

function uniquePath(parts: string[]): string {
  return [
    ...new Set(
      parts.flatMap((part) => part.split(path.delimiter)).filter(Boolean),
    ),
  ].join(path.delimiter);
}
