import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PluginToolApprovals } from "../src/daemon/plugin-tool-approvals.js";
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
    { decision: ["deny"], reason: "Stop" },
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

describe("remembered plugin target consent", () => {
  const scope = { key: "app:macos:com.apple.textedit", label: "com.apple.textedit" };
  async function fixture(run: (directory: string, store: PluginToolApprovals) => Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), "plugin-tool-approvals-"));
    try { await run(directory, new PluginToolApprovals(directory)); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  function scoped(store: PluginToolApprovals) {
    const base = setup({ decision: "ask", reason: "Read and operate this app", remember: scope });
    base.entries.splice(1);
    return { ...base, hooks: new PluginHooks({ resolve: base.resolve, native: { hook: base.hook }, approvals: store }) };
  }
  it("remembers only explicit persistent consent across sessions and restarts; still runs each gate", async () => fixture(async (directory, store) => {
    const { hooks, hook, entries } = scoped(store);
    const once = vi.fn(async () => true);
    await hooks.tools("project", once).before(call);
    await hooks.tools("project", once).before(call);
    expect(once).toHaveBeenCalledTimes(2);
    expect(await store.list(entries[0]!.id)).toEqual([]);
    const always = vi.fn(async () => "allow-always" as const);
    await hooks.tools("project", always).before(call);
    await hooks.tools("another-project", always).before(call);
    expect(always).toHaveBeenCalledOnce();
    expect(always.mock.calls[0]).toEqual([entries[0]!.id, call, "Read and operate this app", undefined, scope]);
    const restarted = scoped(new PluginToolApprovals(directory));
    await restarted.hooks.tools("project", always).before(call);
    expect(always).toHaveBeenCalledOnce();
    await expect(restarted.hooks.tools("project").before(call)).rejects.toThrow("active conversation");
    hook.mockResolvedValueOnce({ decision: "deny", reason: "Blocked now" });
    await expect(hooks.tools("project", always).before(call)).rejects.toThrow("Blocked now");
    entries[0]!.digest = "new-code";
    await expect(hooks.tools("project", async () => false).before(call)).rejects.toThrow("did not approve");
    hook.mockResolvedValueOnce({ decision: "ask", reason: "Another app", remember: { ...scope, key: "app:macos:com.apple.safari" } });
    await expect(hooks.tools("project", async () => false).before(call)).rejects.toThrow("did not approve");
  }));
  it("revokes immediately, rejects pending approvals, and does not grant after cancellation or disable", async () => fixture(async (_directory, store) => {
    const { hooks, entries } = scoped(store);
    const id = entries[0]!.id;
    await hooks.tools("project", async () => "allow-always").before(call);
    const revoke = store.revoke(id, scope.key);
    expect(await store.has(id, entries[0]!.digest, scope)).toBe(false);
    await revoke;
    await expect(hooks.tools("project", async () => false).before(call)).rejects.toThrow("did not approve");
    await expect(hooks.tools("project", async () => {
      await store.revoke(id, scope.key);
      return "allow-always";
    }).before(call)).rejects.toThrow("access changed");
    const abort = new AbortController();
    await expect(hooks.tools("project", async () => {
      abort.abort(); return "allow-always";
    }).before(call, abort.signal)).rejects.toThrow();
    await expect(hooks.tools("project", async () => {
      entries.splice(0); return "allow-always";
    }).before(call)).rejects.toThrow("hooks changed");
    expect(await store.list(id)).toEqual([]);
  }));
  it("rechecks remembered scopes after another hook waits for approval", async () => fixture(async (_directory, store) => {
    const { hooks, hook, entries } = scoped(store);
    await store.grant(entries[0]!.id, entries[0]!.digest, scope, 0);
    entries.push(entry("acme/other"));
    hook.mockImplementation(async (id) => id === entries[0]!.id ? { decision: "ask", reason: "Remembered", remember: scope } : { decision: "ask", reason: "Wait" });
    await expect(hooks.tools("project", async () => {
      await store.revoke(entries[0]!.id, scope.key); return true;
    }).before(call)).rejects.toThrow("access changed");
  }));
  it("recovers after an aborted or stale save without restoring revoked consent", async () => fixture(async (_directory, store) => {
    const { hooks, entries } = scoped(store);
    const plugin = entries[0]!;
    await store.grant("other", "other-digest", scope, 0);
    const stopped = new AbortController();
    stopped.abort();
    await expect(store.grant(plugin.id, plugin.digest, scope, 0, stopped.signal)).rejects.toThrow();
    expect(await store.has("other", "other-digest", scope)).toBe(true);
    const approve = vi.fn(async () => "allow-always" as const);
    await hooks.tools("project", approve).before(call);
    expect(approve).toHaveBeenCalledOnce();
    await store.revoke(plugin.id, scope.key);
    await expect(store.grant(plugin.id, plugin.digest, scope, 0)).rejects.toThrow("access changed");
    expect(await store.has(plugin.id, plugin.digest, scope)).toBe(false);
    await expect(hooks.tools("project", async () => false).before(call)).rejects.toThrow("did not approve");
    expect(await store.has("other", "other-digest", scope)).toBe(true);
  }));
  it("keeps failed revocations blocked while unrelated saved access remains usable", async () => fixture(async (_directory, store) => {
    await store.grant("revoked", "digest", scope, 0);
    await store.grant("forgotten", "digest", scope, 0);
    await store.grant("other", "digest", scope, 0);
    const temporary = `${store.file}.${process.pid}.tmp`;
    await mkdir(temporary);
    await expect(store.revoke("revoked", scope.key)).rejects.toThrow();
    await expect(store.forget("forgotten")).rejects.toThrow();
    expect(await store.has("revoked", "digest", scope)).toBe(false);
    expect(await store.has("forgotten", "digest", scope)).toBe(false);
    expect(await store.has("other", "digest", scope)).toBe(true);
    await rm(temporary, { recursive: true });
    await store.revoke("revoked", scope.key);
    await store.forget("forgotten");
    const restarted = new PluginToolApprovals(path.dirname(store.file));
    expect(await restarted.has("revoked", "digest", scope)).toBe(false);
    expect(await restarted.has("forgotten", "digest", scope)).toBe(false);
    expect(await restarted.has("other", "digest", scope)).toBe(true);
  }));
  it("serializes writes, preserves unknown fields and refuses damaged or future stores", async () => fixture(async (directory, store) => {
    await writeFile(store.file, JSON.stringify({ version: 1, extra: { future: true }, grants: [{ plugin: "other", digest: "old", key: "other", label: "Other", extra: 7 }] }));
    const loaded = new PluginToolApprovals(directory);
    await Promise.all([loaded.grant("a", "digest", scope, 0), loaded.grant("b", "digest", scope, 0)]);
    const document = JSON.parse(await readFile(store.file, "utf8"));
    expect(document.extra).toEqual({ future: true });
    expect(document.grants).toHaveLength(3);
    expect(document.grants[0].extra).toBe(7);
    await loaded.forget("a");
    expect(await loaded.has("a", "digest", scope)).toBe(false);
    expect(await new PluginToolApprovals(directory).list("a")).toEqual([]);
    expect(await loaded.has("b", "digest", scope)).toBe(true);
    for (const raw of ['{"version":99,"grants":[]}', '{broken', '{"version":1,"grants":[{}]}']) {
      await writeFile(store.file, raw);
      const invalid = new PluginToolApprovals(directory);
      await expect(invalid.list("a")).rejects.toThrow();
      await expect(invalid.grant("a", "digest", scope, 0)).rejects.toThrow();
      await expect(invalid.revoke("a", scope.key)).rejects.toThrow();
      expect(await readFile(store.file, "utf8")).toBe(raw);
    }
  }));
  it("does not accept remembered scopes on allow, unknown fields or misleading blank labels", async () => {
    for (const value of [
      { decision: "allow", remember: scope },
      { decision: "ask", reason: "x", remember: { ...scope, label: " " } },
      { decision: "ask", reason: "x", remember: { ...scope, all: true } },
    ]) await expect(setup(value).hooks.tools("project", async () => true).before(call)).rejects.toThrow("remember");
  });
});
