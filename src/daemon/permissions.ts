import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ApprovalKind } from "../shared/contracts.js";

export type ToolPolicyDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "ask"; kind: ApprovalKind; title: string; detail: string };

export function evaluateToolCall(
  workspacePath: string,
  toolName: string,
  input: Record<string, unknown>,
): ToolPolicyDecision {
  if (["read", "write", "edit"].includes(toolName)) {
    const filePath = stringValue(input.path) || stringValue(input.file_path);
    if (filePath && !isInsideWorkspace(workspacePath, filePath)) {
      return { action: "deny", reason: "Paths outside the project workspace are not allowed" };
    }
    return { action: "allow" };
  }

  if (toolName === "bash") {
    const command = stringValue(input.command).trim();
    return { action: "ask", kind: "command", title: "Run command?", detail: command };
  }

  if (toolName === "generate_image") {
    return {
      action: "ask",
      kind: "external-tool",
      title: "Run image generation?",
      detail: "This sends the prompt to an external paid service.",
    };
  }

  return {
    action: "ask",
    kind: "external-tool",
    title: `Run ${toolName}?`,
    detail: "This tool may send data to an external service or cause side effects.",
  };
}

function isInsideWorkspace(workspacePath: string, filePath: string): boolean {
  const workspace = realpathSync(workspacePath);
  const target = path.resolve(workspace, filePath);
  if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`)) return false;

  let existing = target;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  const realExisting = realpathSync(existing);
  return realExisting === workspace || realExisting.startsWith(`${workspace}${path.sep}`);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
