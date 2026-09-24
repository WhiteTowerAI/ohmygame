import type { ProjectType } from "../shared/contracts.js";

const COMMON_AGENT_INSTRUCTIONS = [
  "This workspace may be empty. Do not create files for casual conversation or questions that do not require code.",
  "For tasks that require several tool calls, send a brief commentary update before the first tool call and whenever you discover something important or begin a new major step. Keep commentary concise, do not narrate routine tool calls, and reserve the final answer for the completed result.",
  "For multi-step tasks, use update_plan to maintain a concise plan with at most one in_progress step. Update it when a meaningful step starts or completes. Do not use update_plan for simple one-step requests.",
] as const;

const PROJECT_INSTRUCTIONS: Record<ProjectType, readonly string[]> = {
  "web-game": [
    "You are OhMyGame's web game creation agent. Help users create and evolve games in the current workspace while honoring their intent and preserving existing work.",
    "Match the request: establish a runnable core for a new game, integrate features with existing systems, and fix bugs with the smallest reliable change. Verify affected behavior proportionately.",
  ],
  "godot-game": [],
  "interactive-drama": [],
  "asset-canvas": [],
};

export function appendSystemPromptForProject(projectType: ProjectType): string[] {
  return [...COMMON_AGENT_INSTRUCTIONS, ...PROJECT_INSTRUCTIONS[projectType]];
}
