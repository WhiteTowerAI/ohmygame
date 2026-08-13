import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateToolCall } from "../src/daemon/permissions.js";

describe("tool policy", () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-game-permissions-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  symlinkSync(outside, path.join(workspace, "outside-link"), "dir");

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("allows routine work inside the workspace", () => {
    expect(evaluateToolCall(workspace, "write", { path: "src/app.ts" })).toEqual({ action: "allow" });
    expect(evaluateToolCall(workspace, "bash", { command: "npm test" })).toMatchObject({ action: "ask", kind: "command" });
  });

  it("denies file paths outside the workspace", () => {
    expect(evaluateToolCall(workspace, "read", { path: "../secret" })).toMatchObject({ action: "deny" });
    expect(evaluateToolCall(workspace, "read", { path: "outside-link/secret" })).toMatchObject({ action: "deny" });
  });

  it("asks before every shell command and external tool call", () => {
    expect(evaluateToolCall(workspace, "bash", { command: "rm -rf dist" })).toMatchObject({ action: "ask", kind: "command" });
    expect(evaluateToolCall(workspace, "bash", { command: "cat $HOME/.ssh/id_rsa" })).toMatchObject({ action: "ask", kind: "command" });
    expect(evaluateToolCall(workspace, "generate_image", { prompt: "A forest" })).toMatchObject({ action: "ask", kind: "external-tool" });
  });
});
