import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isBuiltInAgentRuntimeId, type AgentRuntimeId, type BuiltInAgentRuntimeId } from "../../shared/agent-runtimes.js";

/** A Skill, or a command, from the project's own folders that a coding agent loads by itself. */
export interface ProjectSkill {
  name: string;
  description: string;
  /** Its `SKILL.md`, or the command's own file. */
  file: string;
  /** Only the person may start it (`disable-model-invocation`), so the agent's own tool refuses it. */
  userOnly: boolean;
}

/**
 * The project folders each agent reads Skills from by itself, first one first.
 * Claude Code also starts `.claude/commands/<name>.md` as `/name`. Codex was
 * checked with its app server's `skills/list`; OpenCode reads Claude Code's and
 * the shared `.agents` folders unless told not to, and OhMyGame does not.
 */
const PROJECT_SKILLS: Record<BuiltInAgentRuntimeId, { skills: string[]; commands: string[] }> = {
  "claude-code-cli": { skills: [".claude/skills"], commands: [".claude/commands"] },
  "codex-cli": { skills: [".agents/skills", ".codex/skills"], commands: [] },
  "opencode-cli": { skills: [".opencode/skills", ".opencode/skill", ".claude/skills", ".agents/skills"], commands: [] },
};

/** Names a message can carry as `$name`, as `skillMentionRanges` reads them. */
const MENTIONABLE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9_-])?$/;

/**
 * The project's own Skills the runtime's agent loads, one per name. An agent
 * OhMyGame does not ship has none here: its folders are not known.
 */
export async function loadProjectSkills(runtime: AgentRuntimeId, workspacePath: string): Promise<ProjectSkill[]> {
  if (!isBuiltInAgentRuntimeId(runtime)) return [];
  const folders = PROJECT_SKILLS[runtime];
  const found: ProjectSkill[] = [];
  for (const root of folders.skills)
    for (const entry of await entries(path.join(workspacePath, root)))
      if (entry.isDirectory() || entry.isSymbolicLink())
        found.push(...await read(path.join(workspacePath, root, entry.name, "SKILL.md"), entry.name));
  for (const root of folders.commands)
    for (const entry of await entries(path.join(workspacePath, root)))
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
        found.push(...await read(path.join(workspacePath, root, entry.name), entry.name.slice(0, -3), true));
  const names = new Set<string>();
  return found.filter((skill) => !names.has(skill.name) && Boolean(names.add(skill.name)));
}

async function entries(directory: string) {
  try {
    return (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function read(file: string, fallbackName: string, command = false): Promise<ProjectSkill[]> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let frontmatter: Record<string, unknown> = {};
  let body = content;
  try {
    ({ frontmatter, body } = parseFrontmatter(content));
  } catch {
    // An agent skips a Skill whose frontmatter it cannot read, so the list does too.
    if (!command) return [];
  }
  const name = !command && typeof frontmatter.name === "string" ? frontmatter.name.trim() : fallbackName;
  if (!MENTIONABLE.test(name) || flag(frontmatter["user-invocable"]) === false) return [];
  const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
    ? frontmatter.description.trim()
    : command ? body.split("\n").map((line) => line.trim()).find(Boolean) ?? "" : "";
  return [{ name, description, file, userOnly: flag(frontmatter["disable-model-invocation"]) === true }];
}

function flag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
