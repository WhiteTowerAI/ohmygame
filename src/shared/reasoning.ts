import { AGENT_REASONING_LEVELS, type AgentReasoningLevel } from "./contracts.js";

export function reasoningLabel(level?: AgentReasoningLevel): string {
  if (!level) return "Default";
  if (level === "xhigh") return "Extra high";
  return level[0].toUpperCase() + level.slice(1);
}

export function parseReasoningLevel(value: unknown): AgentReasoningLevel | undefined {
  return AGENT_REASONING_LEVELS.find((level) => level === value);
}

export function clampReasoningLevel(
  level: AgentReasoningLevel,
  available: readonly AgentReasoningLevel[],
): AgentReasoningLevel {
  if (available.includes(level)) return level;
  const index = AGENT_REASONING_LEVELS.indexOf(level);
  return AGENT_REASONING_LEVELS.slice(index).find((candidate) => available.includes(candidate)) ??
    [...AGENT_REASONING_LEVELS.slice(0, index)].reverse().find((candidate) => available.includes(candidate)) ??
    "off";
}
