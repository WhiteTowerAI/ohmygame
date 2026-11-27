import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  isBuiltInAgentRuntimeId,
  type AccountRuntimeId,
  type AgentRuntimeId,
  type BuiltInAgentRuntimeId,
} from "../../shared/agent-runtimes.js";
import { EXTERNAL_MCP_DISABLED_ENV } from "../../shared/external-mcp.js";

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

/**
 * Each CLI's own sign-in and configuration location, which it needs to find the person's subscription.
 * `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are not inherited: System default is the
 * CLI's default folder, and the service names an account's folder itself. A
 * value OhMyGame was launched with only reflects whichever account a terminal
 * or account switcher had selected at that moment.
 */
const RUNTIME_KEEP: Record<BuiltInAgentRuntimeId, readonly string[]> = {
  "claude-code-cli": ["CLAUDE_CODE_OAUTH_TOKEN"],
  "codex-cli": [],
  "opencode-cli": ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"],
};

export function agentEnvironment(
  runtime: AgentRuntimeId,
  binaryPath: string,
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
  shellPath?: string,
): Record<string, string> {
  const keep = new Set([
    ...SHARED,
    ...(isBuiltInAgentRuntimeId(runtime) ? RUNTIME_KEEP[runtime] : []),
  ]);
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
  // The person may have connected this CLI to OhMyGame; inside OhMyGame it already has OhMyGame's tools.
  return { ...result, [EXTERNAL_MCP_DISABLED_ENV]: "1", ...extra };
}

/** The folder each CLI uses when no account folder is named, which System default always uses. */
export function systemConfigDirectory(
  runtime: AccountRuntimeId,
  home = os.homedir(),
): string {
  return path.join(home, runtime === "claude-code-cli" ? ".claude" : ".codex");
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
let readingShellPath = false;

/**
 * The PATH a login shell sets up, which an app started from the Dock does not
 * get. Cache until a rescan, with a short limit, between markers so whatever the
 * shell's startup files print is ignored.
 */
export function loginShellPath(recheck = false): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  // Concurrent rescans share a read; a completed read is refreshed on demand.
  if (recheck && !readingShellPath) shellPath = undefined;
  if (shellPath) return shellPath;
  readingShellPath = true;
  shellPath = new Promise<string | undefined>((resolve) => {
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
  }).then((value) => {
    readingShellPath = false;
    // A transient startup failure must not poison discovery until restart.
    if (!value) shellPath = undefined;
    return value;
  });
  return shellPath;
}

const PACKAGE_REGISTRY =
  "HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
const packageRoots = new Map<string, Promise<string[]>>();

/**
 * Install folders of the signed-in person's Microsoft Store packages whose
 * name starts with the prefix, such as "OpenAI.Codex_". An ordinary process
 * cannot list the WindowsApps folder, so the folders are read from the
 * registry. Cached until a rescan.
 */
export function windowsStorePackageRoots(
  prefix: string,
  recheck = false,
): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  if (!recheck && packageRoots.has(prefix)) return packageRoots.get(prefix)!;
  const roots = readWindowsStorePackageRoots(prefix).catch(() => []);
  packageRoots.set(prefix, roots);
  void roots.then((value) => {
    // A failed read must not poison discovery until restart.
    if (!value.length) packageRoots.delete(prefix);
  });
  return roots;
}

async function readWindowsStorePackageRoots(
  prefix: string,
): Promise<string[]> {
  const keys = await registryQuery([PACKAGE_REGISTRY]);
  const values = await Promise.all(
    keys
      .filter((key) => key.split(path.sep).at(-1)!.startsWith(prefix))
      .map((key) => registryQuery([key, "/v", "PackageRootFolder"], true)),
  );
  return values.flat();
}

/** The key names a `reg query` lists, or the text of the string values it finds. Empty when the key is missing. */
function registryQuery(args: string[], values = false): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", ...args],
      { timeout: 10_000, encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        if (error) return resolve([]);
        const lines = stdout.split(/\r?\n/).map((line) => line.trim());
        resolve(
          values
            ? lines.flatMap(
                (line) =>
                  line.match(/\bREG_(?:EXPAND_)?SZ\s+(.*)$/)?.slice(1) ?? [],
              )
            : lines.filter((line) => /^HKEY_/i.test(line)),
        );
      },
    );
  });
}

function uniquePath(parts: string[]): string {
  return [
    ...new Set(
      parts.flatMap((part) => part.split(path.delimiter)).filter(Boolean),
    ),
  ].join(path.delimiter);
}
