import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentUsageLimit } from "../../shared/contracts.js";
import type { DriverContext } from "./driver-context.js";
import { record } from "./driver-context.js";
import {
  StreamJsonDriver,
  type StagedSkills,
  type StreamJsonProfile,
} from "./stream-json.js";
import { stageSkills, stagedSkillsRoot } from "./skills.js";

export {
  permissionAnswer as claudeAnswer,
  permissionSuggestions as claudeAlways,
  streamJsonToolCall as claudeToolCall,
} from "./stream-json.js";

/**
 * Claude Code can launch subagents and shells in the background, and
 * schedule prompts, that report after its turn has ended. A turn here ends
 * with Claude's result, so later reports would have no turn to land in:
 * keep that work in the foreground.
 */
const FOREGROUND_ONLY = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_DISABLE_CRON: "1",
};

/** Claude Code's own bookkeeping, such as loading the schemas of deferred tools, which is not work to show. */
const HIDDEN_TOOLS = new Set(["ToolSearch"]);

/** Claude Code's file-changing tools, which a planning turn refuses whatever the person's rules allow. */
const CHANGE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Skills reach Claude Code as a plugin of this session's own. */
async function stageClaudeSkills(
  directories: readonly string[],
  privateDirectory: string,
): Promise<StagedSkills> {
  const skills = stagedSkillsRoot("claude-code-cli", privateDirectory);
  const plugin = path.dirname(skills);
  await mkdir(path.join(plugin, ".claude-plugin"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    path.join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "ohmygame",
      version: "1.0.0",
      description: "OhMyGame Skills for this project",
    }),
  );
  // Its folder is a working directory too, so reading a Skill's files is not
  // a request to reach outside the project.
  const staged = await stageSkills(directories, skills);
  return staged.length
    ? { args: ["--plugin-dir", plugin, "--add-dir", plugin], env: {} }
    : { args: [], env: {} };
}

const CLAUDE_PROFILE: StreamJsonProfile = {
  id: "claude-code-cli",
  name: "Claude Code",
  env: FOREGROUND_ONLY,
  hiddenTools: HIDDEN_TOOLS,
  changeTools: CHANGE_TOOLS,
  permissionPromptTool: true,
  bypassFlag: "--allow-dangerously-skip-permissions",
  stageSkills: stageClaudeSkills,
  limits: claudeLimits,
};

/**
 * Claude Code over its stream-json protocol, with one long-lived process per
 * session. Messages go in on stdin, which stays open for later turns. OhMyGame's tools are an
 * in-process MCP server answered over the same pipe, and permission requests
 * come back on it too: no port, no token, no file in the workspace. Claude
 * Code's own permission rules decide what it asks; OhMyGame shows the
 * question and returns the person's answer.
 */
export class ClaudeCodeDriver extends StreamJsonDriver {
  constructor(context: DriverContext) {
    super(context, CLAUDE_PROFILE);
  }
}

const CLAUDE_WINDOWS: Record<string, number> = {
  five_hour: 300,
  seven_day: 7 * 24 * 60,
};

/**
 * Claude Code's subscription windows from a `rate_limit_event`: every window
 * it tracks when it reports them, otherwise the one currently limiting.
 * Utilization is a fraction of the window, and may pass 1.
 */
export function claudeLimits(
  info: Record<string, unknown> | undefined,
): AgentUsageLimit[] {
  const limit = (
    name: string,
    utilization: unknown,
    resetsAt: unknown,
  ): AgentUsageLimit[] =>
    typeof utilization === "number" && CLAUDE_WINDOWS[name]
      ? [
          {
            id: `claude/${name}`,
            usedPercent: Math.max(0, Math.min(100, utilization * 100)),
            windowMinutes: CLAUDE_WINDOWS[name],
            ...(typeof resetsAt === "number" ? { resetsAt } : {}),
          },
        ]
      : [];
  const windows = record(info?.unifiedWindows);
  const tracked = Object.keys(CLAUDE_WINDOWS).flatMap((name) => {
    const window = record(windows?.[name]);
    return limit(name, window?.utilization, window?.resetsAt);
  });
  return tracked.length
    ? tracked
    : limit(String(info?.rateLimitType), info?.utilization, info?.resetsAt);
}
