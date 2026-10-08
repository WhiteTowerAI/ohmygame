import { AGENT_REASONING_LEVELS, type AgentReasoningLevel, type CustomThinkingLevelMap } from "./contracts.js";

export function compatibleReasoningProtocols(from: string, to: string): boolean {
  const openAI = (api: string) => api === "openai-completions" || api === "openai-responses";
  return from === to || openAI(from) && openAI(to);
}

export function supportedReasoningLevels(model: { reasoning: boolean; thinkingLevelMap?: CustomThinkingLevelMap }): AgentReasoningLevel[] {
  if (!model.reasoning) return ["off"];
  return AGENT_REASONING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (level !== "xhigh" && level !== "max" || mapped !== undefined);
  });
}

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
