import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PluginHooks } from "../src/daemon/plugin-hooks.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import {
  pluginToolApprovalRequest,
  toolHookResult,
  toolHooksExtension,
} from "../src/daemon/tool-hooks.js";
import type { PluginIndexEntry } from "../src/daemon/plugin-index.js";
import type { ProjectPlugins } from "../src/daemon/project-plugins.js";
import type { ToolHookInput } from "../src/shared/plugin-hooks.js";

const call: ToolHookInput = {
  callId: "one",
  tool: "echo",
  args: { value: "original" },
  source: "agent",
};
const entry = (id: string) =>
  ({
    id,
    version: "1.0.0",
    digest: id,
    manifest: {
      entrypoints: { native: "./index.mjs" },
      contributes: { hooks: ["tool.beforeCall", "tool.afterCall"] },
    },
  }) as unknown as PluginIndexEntry;
function setup(answer: unknown = { decision: "allow" }) {
  const entries = [entry("acme/first"), entry("acme/second")];
  const resolve = vi.fn(
    async () =>
      ({
        ok: true,
        plugins: entries.map((entry) => ({
          id: entry.id,
          status: "active",
          entry,
        })),
      }) as ProjectPlugins,
  );
  const hook = vi.fn(
    async (_id: string, _event: string, _options: { input?: unknown }) =>
      answer,
  );
  const hooks = new PluginHooks({ resolve, native: { hook } });
  return { entries, resolve, hook, hooks };
}

describe("plugin tool gates", () => {
  it("runs gates in order with isolated arguments, then sends a read-only bounded result", async () => {
    const { hooks, hook } = setup();
    hook.mockImplementation(async (_id, event, options) => {
      if (event === "tool.beforeCall") {
        expect(options.input).toEqual(call);
        (options.input as ToolHookInput).args.value = "changed";
        return { decision: "allow" };
      }
      return { text: "replace the result" };
    });
    const execute = vi.fn(async (_id, input) => ({
      content: [{ type: "text" as const, text: input.value }],
      details: undefined,
    }));
    const bridge = new ToolBridge(
      [
        {
          name: "echo",
          label: "Echo",
          description: "Echo",
          parameters: Type.Object({ value: Type.String() }),
          execute,
        },
      ],
      hooks.tools("/project"),
    );
    expect(
      (await bridge.call("echo", call.args, "one")).result.content,
    ).toEqual([{ type: "text", text: "original" }]);
    await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(4));
    expect(hook.mock.calls.slice(0, 2).map(([id]) => id)).toEqual([
      "acme/first",
      "acme/second",
    ]);
    expect(call.args.value).toBe("original");
    const result = toolHookResult(call, false, [
      { type: "image", data: "private binary" },
      { type: "text", text: "x".repeat(8001) },
    ]);
    expect(result.text).toHaveLength(8000);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private binary");
  });

  it.each([
    undefined,
    null,
    {},
    { decision: "allow", args: {} },
    { decision: "deny" },
    { decision: "ask", reason: " " },
    { decision: "allow", reason: "x".repeat(301) },
  ])("refuses malformed answers: %j", async (answer) => {
    const { hooks, hook } = setup();
    hook.mockResolvedValue(answer);
    await expect(hooks.tools("/project").before(call)).rejects.toThrow(
      "acme/first",
    );
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("fails closed on resolution and hook errors, and preserves the plugin's denial reason", async () => {
    const { hooks, hook, resolve } = setup({
      decision: "deny",
      reason: "Desktop control is disabled",
    });
    await expect(hooks.tools("/project").before(call)).rejects.toThrow(
      "acme/first: Desktop control is disabled",
    );
    hook.mockRejectedValue(new Error("timeout"));
    await expect(hooks.tools("/project").before(call)).rejects.toThrow(
      "timeout",
    );
    resolve.mockRejectedValue(new Error("unreadable project"));
    await expect(hooks.tools("/project").before(call)).rejects.toThrow(
      "unreadable project",
    );
  });

  it("asks for each call and each requesting plugin; denial or no conversation never runs the tool", async () => {
    const { hooks } = setup({ decision: "ask", reason: "Control the desktop" });
    const approve = vi.fn(async () => true);
    const gates = hooks.tools("/project", approve);
    await gates.before(call);
    await gates.before({ ...call, callId: "two" });
    expect(approve).toHaveBeenCalledTimes(4);
    approve.mockResolvedValue(false);
    await expect(gates.before(call)).rejects.toThrow("did not approve");
    await expect(hooks.tools("/project").before(call)).rejects.toThrow(
      "active conversation",
    );
  });

  it("rejects a changed gate or cancellation while approval is pending", async () => {
    const { hooks, entries } = setup({
      decision: "ask",
      reason: "Control the desktop",
    });
    await expect(
      hooks
        .tools("/project", async () => {
          entries.pop();
          return true;
        })
        .before(call),
    ).rejects.toThrow("hooks changed");
    entries.push(entry("acme/first"));
    const controller = new AbortController();
    await expect(
      hooks
        .tools("/project", async () => {
          controller.abort();
          return true;
        })
        .before(call, controller.signal),
    ).rejects.toThrow();
  });

  it("validates before gates, and denies bridge execution without an after notification", async () => {
    const execute = vi.fn(async () => ({ content: [], details: undefined }));
    const before = vi.fn(async () => {
      throw new Error("Gate refused");
    });
    const after = vi.fn(async () => {});
    const bridge = new ToolBridge(
      [
        {
          name: "echo",
          label: "Echo",
          description: "Echo",
          parameters: Type.Object({ value: Type.String() }),
          execute,
        },
      ],
      { before, after },
      "external",
    );
    expect((await bridge.call("echo", {}, "one")).isError).toBe(true);
    expect(before).not.toHaveBeenCalled();
    expect(
      (await bridge.call("echo", call.args, "two")).result.content,
    ).toEqual([{ type: "text", text: "Gate refused" }]);
    expect(before.mock.calls[0]).toMatchObject([
      { source: "external", callId: "two" },
      undefined,
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("blocks Pi explicitly on gate failure and leaves MCP calls to their inner boundary", async () => {
    const handlers = new Map<
      string,
      (event: never) => Promise<unknown> | unknown
    >();
    const before = vi.fn(async () => {
      throw new Error("Gate refused");
    });
    const after = vi.fn(async () => {});
    await toolHooksExtension(
      { before, after },
      () => new AbortController().signal,
      new Set(["mcp", "local_echo"]),
    )({
      on: (event: string, handler: (event: never) => unknown) =>
        handlers.set(event, handler),
    } as unknown as ExtensionAPI);
    const event = {
      toolName: "bash",
      toolCallId: "one",
      input: { command: "echo hi" },
    } as never;
    expect(await handlers.get("tool_call")!(event)).toEqual({
      block: true,
      reason: "Gate refused",
    });
    await handlers.get("tool_result")!(event);
    expect(after).not.toHaveBeenCalled();
    expect(
      await handlers.get("tool_call")!({ toolName: "local_echo" } as never),
    ).toBeUndefined();
    expect(before).toHaveBeenCalledTimes(1);
  });
});

it("keeps the approval input exact and refuses an unreviewable oversized call", () => {
  const request = pluginToolApprovalRequest(
    "acme/guard",
    call,
    "Confirm action",
  );
  expect(JSON.parse(request.input!)).toEqual(call.args);
  expect(request.always).toBeUndefined();
  expect(() =>
    pluginToolApprovalRequest(
      "acme/guard",
      { ...call, args: { value: "x".repeat(8000) } },
      "Confirm",
    ),
  ).toThrow("too large");
});
