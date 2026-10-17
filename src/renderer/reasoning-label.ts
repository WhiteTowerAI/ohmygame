import type { AgentReasoningLevel } from "../shared/contracts.js";
import { t } from "./i18n.js";

export function reasoningLabel(level?: AgentReasoningLevel): string {
  return t(`reasoning.${level ?? "default"}`);
}
