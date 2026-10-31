import type { DriverContext } from "./driver-context.js";
import {
  StreamJsonDriver,
  type StagedSkills,
  type StreamJsonProfile,
} from "./stream-json.js";
import { stageSkills, stagedSkillsRoot } from "./skills.js";

/**
 * CodeBuddy can run teammates, background sessions and scheduled prompts
 * that report after its turn has ended. A turn here ends with CodeBuddy's
 * result, so later reports would have no turn to land in: keep that work in
 * the foreground.
 */
const FOREGROUND_ONLY = {
  CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CODEBUDDY_DISABLE_CRON: "1",
};

/** CodeBuddy's own bookkeeping, such as loading the schemas of deferred tools, which is not work to show. */
const HIDDEN_TOOLS = new Set(["ToolSearch"]);

/** CodeBuddy's file-changing tools, which a planning turn refuses whatever the person's rules allow. */
const CHANGE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * CodeBuddy finds Skills by scanning folders, and reads the ones in
 * `CODEBUDDY_SESSION_SKILL_DIRS` for this session only. The folder is also a
 * working directory, so reading a Skill's files is not a request to reach
 * outside the project.
 */
async function stageCodeBuddySkills(
  directories: readonly string[],
  privateDirectory: string,
): Promise<StagedSkills> {
  const skills = stagedSkillsRoot("codebuddy-cli", privateDirectory);
  const staged = await stageSkills(directories, skills);
  return staged.length
    ? {
        args: ["--add-dir", skills],
        env: { CODEBUDDY_SESSION_SKILL_DIRS: skills },
      }
    : { args: [], env: {} };
}

const CODEBUDDY_PROFILE: StreamJsonProfile = {
  id: "codebuddy-cli",
  name: "CodeBuddy Code",
  env: FOREGROUND_ONLY,
  hiddenTools: HIDDEN_TOOLS,
  changeTools: CHANGE_TOOLS,
  // CodeBuddy has no --permission-prompt-tool: in stream-json mode it asks on the control channel.
  permissionPromptTool: false,
  bypassFlag: "--dangerously-skip-permissions",
  stageSkills: stageCodeBuddySkills,
};

/**
 * CodeBuddy Code over Claude Code's stream-json protocol, which it implements
 * message for message: one long-lived process per session, OhMyGame's tools
 * as an in-process MCP server over the same pipe, and permission requests
 * answered on it. CodeBuddy's own permission rules decide what it asks;
 * OhMyGame shows the question and returns the person's answer. It reports no
 * subscription windows, so a conversation of its own shows no quota.
 */
export class CodeBuddyDriver extends StreamJsonDriver {
  constructor(context: DriverContext) {
    super(context, CODEBUDDY_PROFILE);
  }
}
