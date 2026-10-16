import os from "node:os";
import path from "node:path";
import type { ApprovalRequestDetails } from "../../shared/agent-runtimes.js";

export type PolicyVerdict = "allow" | "deny" | "ask";

export interface AgentPolicyContext {
  workspacePath: string;
  /** Places no agent reaches in any mode: sign-ins, OhMyGame's own data, other projects. */
  neverTouch: readonly string[];
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
  const workspace = path.resolve(context.workspacePath);
  if (details.path) {
    const target = path.resolve(workspace, expandHome(details.path));
    // The workspace may itself be inside OhMyGame's data folder, which is otherwise out of bounds.
    if (inside(target, workspace))
      return details.kind === "file" || details.kind === "other"
        ? "allow"
        : "ask";
    if (reaches(target, context.neverTouch)) return "deny";
    return "ask";
  }
  if (details.command !== undefined) {
    const command = details.command;
    const named = commandPaths(command, workspace);
    if (
      named.some(
        (target) =>
          !inside(target, workspace) && reaches(target, context.neverTouch),
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
    return "allow";
  }
  return details.kind === "tool" ? "allow" : "ask";
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
    (root) =>
      inside(target, root) ||
      (inside(root, target) && target !== path.parse(target).root),
  );
}
