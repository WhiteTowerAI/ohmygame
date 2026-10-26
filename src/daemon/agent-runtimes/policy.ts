import os from "node:os";
import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import type { ApprovalRequestDetails } from "../../shared/agent-runtimes.js";

export type PolicyVerdict = "allow" | "deny" | "ask";

export interface AgentPolicyContext {
  workspacePath: string;
  /** Protected roots checked when the native runtime requests permission. */
  neverTouch: readonly string[];
  /** Host-owned copies of this session's Skills; reading does not grant access to adjacent app data. */
  readablePaths?: readonly string[];
  /**
   * Commands run in an OS sandbox that keeps their writes in the workspace and
   * protected roots unreadable, so only what it cannot judge is asked about:
   * commands that publish or escalate, and paths outside the workspace.
   */
  sandboxedCommands?: boolean;
  /**
   * The person gave the agent full access: nothing is asked, as with
   * OhMyGame's own agent. Protected roots a request names are still refused.
   */
  fullAccess?: boolean;
}

/** Planning only reads, whatever the agent's sandbox or permission mode. */
export function planningPolicy(
  context: AgentPolicyContext,
): AgentPolicyContext {
  return { ...context, sandboxedCommands: false, fullAccess: false };
}

/**
 * The places every coding agent is kept out of. A CLI's own sign-in folder is
 * the first: an agent that can read it can take the person's subscription.
 * OhMyGame's own agent folder holds every provider key and sign-in the person
 * configured; the desktop app keeps it beside the data folder, not inside it.
 */
export function neverTouchPaths(
  dataDirectory: string,
  piAgentDirectory: string,
  otherWorkspaces: readonly string[] = [],
  home = os.homedir(),
): string[] {
  return [
    path.join(home, ".claude"),
    path.join(home, ".claude.json"),
    path.join(home, ".codex"),
    path.join(home, ".config", "opencode"),
    path.join(home, ".local", "share", "opencode"),
    path.join(home, ".pi"),
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".config", "gh"),
    path.join(home, "Library", "Keychains"),
    ...[
      process.env.CODEX_HOME,
      process.env.CLAUDE_CONFIG_DIR,
      process.env.OPENCODE_CONFIG_DIR,
      process.env.OPENCODE_CONFIG,
      process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
        : undefined,
      process.env.XDG_DATA_HOME
        ? path.join(process.env.XDG_DATA_HOME, "opencode")
        : undefined,
    ].filter((value): value is string => !!value),
    path.resolve(dataDirectory),
    path.resolve(piAgentDirectory),
    ...otherWorkspaces.map((workspace) => path.resolve(workspace)),
  ];
}

/**
 * What OhMyGame says before the person is asked. OhMyGame's own agent works
 * in the workspace without asking, so a coding agent does too; it is stopped
 * outright where no agent may go, and the person decides the rest: files
 * outside the workspace and commands that publish, escalate or reach outside.
 */
export function judgeApproval(
  details: ApprovalRequestDetails,
  context: AgentPolicyContext,
): PolicyVerdict {
  const verdict = judgeRequest(details, context);
  return verdict === "ask" && context.fullAccess ? "allow" : verdict;
}

function judgeRequest(
  details: ApprovalRequestDetails,
  context: AgentPolicyContext,
): PolicyVerdict {
  if (details.paths?.length) {
    const verdicts = details.paths.map((entry) =>
      judgeRequest(
        {
          ...details,
          kind: "file",
          tool: entry.access === "read" ? "Read" : "Write",
          paths: undefined,
          path: entry.path,
        },
        context,
      ),
    );
    if (verdicts.includes("deny")) return "deny";
    if (verdicts.includes("ask")) return "ask";
  }
  const workspace = canonicalPath(context.workspacePath);
  const protectedPaths = context.neverTouch.map(canonicalPath);
  const readablePaths = (context.readablePaths ?? []).map(canonicalPath);
  if (details.path) {
    const target = canonicalPath(
      path.resolve(workspace, expandHome(details.path)),
    );
    if (
      ["read", "glob", "grep", "ls", "list", "external_directory"].includes(
        details.tool.toLowerCase(),
      ) &&
      readablePaths.some((root) => inside(target, root))
    )
      return "allow";
    if (
      protectedPaths.some(
        (root) => inside(root, workspace) && reaches(target, [root]),
      )
    )
      return "deny";
    // The workspace may itself be inside OhMyGame's data folder, which is otherwise out of bounds.
    if (inside(target, workspace))
      return details.kind === "file" || details.kind === "other"
        ? "allow"
        : "ask";
    if (reaches(target, protectedPaths)) return "deny";
    return "ask";
  }
  if (details.command !== undefined) {
    const command = details.command;
    const named = commandPaths(command, workspace).map(canonicalPath);
    const protectedInWorkspace = protectedPaths.filter((root) =>
      inside(root, workspace),
    );
    if (
      named.some(
        (target) =>
          !readablePaths.some((root) => inside(target, root)) &&
          reaches(
            target,
            inside(target, workspace) ? protectedInWorkspace : protectedPaths,
          ),
      )
    )
      return "deny";
    if (RISKY_COMMAND.test(command)) return "ask";
    if (
      named.some(
        (target) =>
          !inside(target, workspace) &&
          !SAFE_OUTSIDE.some((root) => inside(target, root)),
      )
    )
      return "ask";
    if (context.sandboxedCommands) return "allow";
    return SAFE_COMMAND.test(command.trim()) &&
      !SHELL_CONTROL.test(command) &&
      !UNSCOPED_ARGUMENT.test(command)
      ? "allow"
      : "ask";
  }
  return details.kind === "tool" ? "allow" : "ask";
}

// Commands that cannot be scoped from their syntax (interpreters, build scripts,
// compound commands) require a person's decision. This is not an OS sandbox.
const SAFE_COMMAND = /^(?:pwd|ls|cat|head|tail|wc|rg|grep)\b/;
const SHELL_CONTROL =
  /[\n;&|<>`$]|(?:^|\s)--(?:pre|exec|hostname-bin)(?:=|\s|$)|(?:^|\s)(?:-exec|-execdir|-delete)(?:\s|$)/;

// Globs expand to paths this check never sees, and recursive link-following
// (`grep -R`, `rg -L`, `ls -LR`) reaches whatever workspace links point at.
const UNSCOPED_ARGUMENT =
  /[*?[\]{}]|(?:^|\s)(?:-[A-Za-z]*[RL][A-Za-z]*|--dereference-recursive|--follow)(?=\s|$)/;

/** Resolve links even when the final file has not been created yet. */
export function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  let current = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * What allowing a request for the rest of a conversation should cover, so a
 * person is not asked again for each variation of the same thing: `git push`
 * to any remote, or another file in a folder they let the agent read. Only
 * reads widen, and a command's paths only when its sandbox keeps its writes
 * in the workspace; escalations and everything else stay exact.
 */
export function approvalScope(
  details: ApprovalRequestDetails,
  context: AgentPolicyContext,
): ApprovalRequestDetails["sessionScope"] {
  const workspace = canonicalPath(context.workspacePath);
  if (details.command !== undefined) {
    if (!context.sandboxedCommands) return undefined;
    const risky = [...details.command.matchAll(RISKY_COMMANDS)].map((match) =>
      match[2]!.replace(/\s+/g, " "),
    );
    if (risky.some((command) => !REPEATABLE_COMMAND.test(command)))
      return undefined;
    const outside = commandPaths(details.command, workspace)
      .map(canonicalPath)
      .filter(
        (target) =>
          !inside(target, workspace) &&
          !SAFE_OUTSIDE.some((root) => inside(target, root)),
      );
    return scope([...new Set(risky)], outside);
  }
  const reads = details.paths?.length
    ? details.paths
    : details.path
      ? [
          {
            path: details.path,
            access: readTool(details.tool) ? "read" : "write",
          },
        ]
      : [];
  if (!reads.length || reads.some((entry) => entry.access !== "read"))
    return undefined;
  return scope(
    [],
    reads.map((entry) =>
      canonicalPath(path.resolve(workspace, expandHome(entry.path))),
    ),
  );
}

function scope(
  commands: string[],
  paths: string[],
): ApprovalRequestDetails["sessionScope"] {
  const folders: string[] = [];
  for (const target of paths) {
    const folder = isDirectory(target) ? target : path.dirname(target);
    // Reading anywhere in the home folder or the disk is not a folder grant.
    if (
      folder === path.parse(folder).root ||
      folder === canonicalPath(os.homedir())
    )
      return undefined;
    if (!folders.includes(folder)) folders.push(folder);
  }
  if (!commands.length && !folders.length) return undefined;
  return {
    ...(commands.length ? { commands } : {}),
    ...(folders.length ? { readFolders: folders } : {}),
  };
}

function readTool(tool: string): boolean {
  return ["read", "glob", "grep", "ls", "list", "external_directory"].includes(
    tool.toLowerCase(),
  );
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Commands that act beyond this machine's project or with more rights than the agent was given. */
const RISKY_SOURCE =
  /(^|[\s;&|(])(sudo|su|doas|git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|security|launchctl|crontab|chmod\s+-R\s+777|curl[^|]*\|\s*(sh|bash|zsh)|wget[^|]*\|\s*(sh|bash|zsh))\b/
    .source;
const RISKY_COMMAND = new RegExp(RISKY_SOURCE);
const RISKY_COMMANDS = new RegExp(RISKY_SOURCE, "g");
/** Publishing the person may allow once per conversation, whatever the remote or package; escalations are asked each time. */
const REPEATABLE_COMMAND = /^(?:git push|(?:npm|pnpm|yarn) publish)$/;

/** Installed programs commands may name without the person being asked. Shared temporary folders are outside the workspace. */
const SAFE_OUTSIDE = [
  "/dev/null",
  "/usr",
  "/bin",
  "/opt/homebrew",
  "/Library/Developer",
].map((root) => path.resolve(root));

function commandPaths(command: string, workspace: string): string[] {
  // Keep the source scan for paths inside shell wrappers, and complete quoted
  // or escaped arguments for paths containing spaces. Neither evaluates shell code.
  const words = new Set(command.replace(/["'`]/g, " ").split(/[\s;&|()<>]+/));
  // Scan each quote style independently, including double quotes inside `sh -c '…'`.
  for (const quoted of [/"([^"]*)"/g, /'([^']*)'/g])
    for (const match of command.matchAll(quoted)) words.add(match[1]!);
  for (const match of command.matchAll(/(?:\\[\s\S]|[^\s;&|()<>"'`\\])+/g))
    words.add(match[0].replace(/\\([ \t])/g, "$1"));
  const paths: string[] = [];
  for (const raw of words) {
    const word = raw.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
    if (!word) continue;
    if (
      word.startsWith("~") ||
      word.startsWith("$HOME") ||
      word.startsWith("${HOME}")
    )
      paths.push(path.resolve(expandHome(word.replace(/^\$\{?HOME\}?/, "~"))));
    else if (path.isAbsolute(word)) paths.push(path.resolve(word));
    else if (word === ".." || word.startsWith("../"))
      paths.push(path.resolve(workspace, word));
    else if (!word.startsWith("-")) paths.push(path.resolve(workspace, word));
  }
  return paths;
}

function expandHome(value: string): string {
  return value === "~"
    ? os.homedir()
    : value.startsWith("~/")
      ? path.join(os.homedir(), value.slice(2))
      : value;
}

export function inside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** A path reaches a protected place when it is in it, or holds it: `rm -rf ~` reaches `~/.ssh`. */
function reaches(target: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some(
    (root) => inside(target, root) || inside(root, target),
  );
}
