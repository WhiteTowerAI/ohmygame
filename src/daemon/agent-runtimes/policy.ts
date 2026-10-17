import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import type { ApprovalRequestDetails } from "../../shared/agent-runtimes.js";

export type PolicyVerdict = "allow" | "deny" | "ask";

export interface AgentPolicyContext {
  workspacePath: string;
  /** Protected roots checked when the native runtime requests permission. */
  neverTouch: readonly string[];
  /** Host-owned copies of this session's Skills; reading does not grant access to adjacent app data. */
  readablePaths?: readonly string[];
}

/**
 * The places every coding agent is kept out of. A CLI's own sign-in folder is
 * the first: an agent that can read it can take the person's subscription.
 */
export function neverTouchPaths(
  dataDirectory: string,
  otherWorkspaces: readonly string[] = [],
  home = os.homedir(),
): string[] {
  return [
    path.join(home, ".claude"),
    path.join(home, ".claude.json"),
    path.join(home, ".codex"),
    path.join(home, ".config", "opencode"),
    path.join(home, ".local", "share", "opencode"),
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".config", "gh"),
    path.join(home, "Library", "Keychains"),
    ...[
      process.env.CODEX_HOME,
      process.env.CLAUDE_CONFIG_DIR,
      process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
        : undefined,
      process.env.XDG_DATA_HOME
        ? path.join(process.env.XDG_DATA_HOME, "opencode")
        : undefined,
    ].filter((value): value is string => !!value),
    path.resolve(dataDirectory),
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
  if (details.paths?.length) {
    const verdicts = details.paths.map((entry) =>
      judgeApproval(
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

/** Commands that act beyond this machine's project or with more rights than the agent was given. */
const RISKY_COMMAND =
  /(^|[\s;&|(])(sudo|su|doas|git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|security|launchctl|crontab|chmod\s+-R\s+777|curl[^|]*\|\s*(sh|bash|zsh)|wget[^|]*\|\s*(sh|bash|zsh))\b/;

/** Places commands may name without the person being asked: temporary files and installed programs. */
const SAFE_OUTSIDE = [
  os.tmpdir(),
  "/tmp",
  "/private/tmp",
  "/dev/null",
  "/usr",
  "/bin",
  "/opt/homebrew",
  "/Library/Developer",
].map((root) => path.resolve(root));

function commandPaths(command: string, workspace: string): string[] {
  // Quotes are dropped first, so a path inside `sh -c '…'` or a quoted argument is seen too.
  const words = command.replace(/["'`]/g, " ").split(/[\s;&|()<>]+/);
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

function inside(target: string, root: string): boolean {
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
