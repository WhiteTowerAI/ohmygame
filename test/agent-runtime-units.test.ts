import { SessionManager, defineTool } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentEnvironment } from "../src/daemon/agent-runtimes/environment.js";
import {
  parseVersion,
  compareVersions,
  versionAtLeast,
} from "../src/daemon/agent-runtimes/definitions.js";
import {
  parseOpenCodeModels,
  resolveBinary,
} from "../src/daemon/agent-runtimes/discovery.js";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { handoffSummary } from "../src/daemon/agent-runtimes/handoff.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import { piToolCall } from "../src/daemon/agent-runtimes/driver-context.js";
import {
  claudeAlways,
  claudeAnswer,
  claudeToolCall,
} from "../src/daemon/agent-runtimes/claude-code.js";
import {
  codexAnswer,
  codexApproval,
} from "../src/daemon/agent-runtimes/codex.js";
import {
  openCodeToolCall,
  splitModel,
} from "../src/daemon/agent-runtimes/opencode.js";

describe("Claude Code's own permission suggestions", () => {
  const suggestions = [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm run build:*" }],
      behavior: "allow",
      destination: "localSettings",
    },
    {
      type: "addDirectories",
      directories: ["/Users/me/assets"],
      destination: "session",
    },
  ];

  it("offers always allowing what Claude Code suggests, saved when it saves any of it", () => {
    expect(claudeAlways(suggestions)).toEqual({
      scope: "saved",
      rules: ["Bash(npm run build:*)", "/Users/me/assets"],
    });
    expect(claudeAlways([suggestions[1]!])).toEqual({
      scope: "session",
      rules: ["/Users/me/assets"],
    });
    expect(claudeAlways([])).toBeUndefined();
    // Suggestions to deny or ask are not something to offer the person.
    expect(
      claudeAlways([{ ...suggestions[0]!, behavior: "deny" }]),
    ).toBeUndefined();
  });

  it("returns its suggestions when the person always allows, and nothing extra otherwise", () => {
    const input = { command: "npm run build" };
    expect(claudeAnswer("allow-always", input, suggestions)).toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: suggestions,
      decisionClassification: "user_permanent",
    });
    expect(claudeAnswer("allow", input, suggestions)).toEqual({
      behavior: "allow",
      updatedInput: input,
      decisionClassification: "user_temporary",
    });
    expect(claudeAnswer("deny", input, suggestions)).toMatchObject({
      behavior: "deny",
      decisionClassification: "user_reject",
    });
  });
});

describe("Codex's own approvals", () => {
  it("shows a command request and saves Codex's proposed rule when always allowed", () => {
    const params = {
      itemId: "item-1",
      command: "/bin/zsh -lc 'npm install three'",
      reason: "Needs the network",
      proposedExecpolicyAmendment: ["npm", "install"],
    };
    expect(
      codexApproval("item/commandExecution/requestApproval", params),
    ).toEqual({
      kind: "command",
      tool: "shell",
      command: "npm install three",
      reason: "Needs the network",
      always: { scope: "saved", rules: ["npm install"] },
    });
    expect(
      codexAnswer("item/commandExecution/requestApproval", params, "allow-always"),
    ).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["npm", "install"],
        },
      },
    });
    expect(
      codexAnswer("item/commandExecution/requestApproval", params, "allow"),
    ).toEqual({ decision: "accept" });
    expect(
      codexAnswer("item/commandExecution/requestApproval", params, "deny"),
    ).toEqual({ decision: "decline" });
  });

  it("allows for the session when Codex proposes no rule", () => {
    const params = { command: "make" };
    expect(
      codexApproval("item/commandExecution/requestApproval", params)?.always,
    ).toEqual({ scope: "session", rules: [] });
    expect(
      codexAnswer("item/commandExecution/requestApproval", params, "allow-always"),
    ).toEqual({ decision: "acceptForSession" });
    expect(
      codexAnswer("item/fileChange/requestApproval", {}, "allow-always"),
    ).toEqual({ decision: "acceptForSession" });
    expect(
      codexAnswer("execCommandApproval", params, "allow-always"),
    ).toEqual({ decision: "approved_for_session" });
  });

  it("grants exactly what a permission request names, for the turn or the session", () => {
    const permissions = {
      fileSystem: { read: ["/Users/me/assets"], write: null },
      network: { enabled: true },
    };
    expect(
      codexApproval("item/permissions/requestApproval", { permissions }),
    ).toEqual({
      kind: "other",
      tool: "permissions",
      paths: [{ path: "/Users/me/assets", access: "read" }],
      network: true,
      always: { scope: "session", rules: [] },
    });
    expect(
      codexAnswer("item/permissions/requestApproval", { permissions }, "allow"),
    ).toEqual({ permissions, scope: "turn" });
    expect(
      codexAnswer(
        "item/permissions/requestApproval",
        { permissions },
        "allow-always",
      ),
    ).toEqual({ permissions, scope: "session" });
    expect(
      codexAnswer("item/permissions/requestApproval", { permissions }, "deny"),
    ).toEqual({ permissions: {}, scope: "turn" });
    expect(codexApproval("item/tool/call", {})).toBeUndefined();
  });
});

describe("conversation handoff", () => {
  it("summarizes what was said and touched, without the private context of each message", () => {
    const session = SessionManager.inMemory("/tmp/p");
    session.appendMessage({
      role: "user",
      content:
        'Make a title screen\n\n<workspace-file-references>\n["a.png"]\n</workspace-file-references>',
      timestamp: 1,
    });
    session.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Added the title screen." },
        {
          type: "toolCall",
          id: "c1",
          name: "write",
          arguments: { path: "src/title.ts" },
        },
      ],
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    } as never);
    const summary = handoffSummary(session.getBranch())!;
    expect(summary).toContain("User: Make a title screen");
    expect(summary).not.toContain("workspace-file-references");
    expect(summary).toContain("Assistant: Added the title screen.");
    expect(summary).toContain("src/title.ts");
    expect(handoffSummary([])).toBeUndefined();
  });

  it("keeps the most recent turns when the conversation is long", () => {
    const session = SessionManager.inMemory("/tmp/p");
    for (let index = 0; index < 30; index++)
      session.appendMessage({
        role: "user",
        content: `message ${index}`,
        timestamp: index,
      });
    const summary = handoffSummary(session.getBranch())!;
    expect(summary).toContain("message 29");
    expect(summary).not.toContain("message 0\n");
    expect(summary).toContain("earlier turns omitted");
  });
});

describe("OhMyGame tool bridge", () => {
  const echo = defineTool({
    name: "echo_tool",
    label: "Echo",
    description: "Echo a value",
    parameters: Type.Object({ value: Type.String({ minLength: 1 }) }),
    execute: async (_id, input) => ({
      content: [{ type: "text", text: `echo ${input.value}` }],
      details: {
        artifact: { type: "image", path: "a.png", mediaType: "image/png" },
      },
    }),
  });
  const failing = defineTool({
    name: "fail_tool",
    label: "Fail",
    description: "Fails",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("Nope");
    },
  });
  const bash = defineTool({
    name: "bash",
    label: "Bash",
    description: "Pi's shell",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  });

  it("offers OhMyGame's tools but not the file and shell tools every agent has", () => {
    const bridge = new ToolBridge([echo, failing, bash] as never);
    expect(bridge.list().map((tool) => tool.name)).toEqual([
      "echo_tool",
      "fail_tool",
    ]);
    expect(bridge.list()[0]!.inputSchema).toMatchObject({
      type: "object",
      properties: { value: { type: "string" } },
    });
    // Claude Code would otherwise hide them behind its tool search.
    expect(bridge.list()[0]!._meta).toEqual({ "anthropic/alwaysLoad": true });
    bridge.setActive(["fail_tool"]);
    expect(bridge.list().map((tool) => tool.name)).toEqual(["fail_tool"]);
    expect(bridge.list("all").map((tool) => tool.name)).toEqual([
      "echo_tool",
      "fail_tool",
    ]);
  });

  it("answers MCP, validates arguments and keeps the tool's own result for the record", async () => {
    const bridge = new ToolBridge([echo, failing] as never);
    expect(
      await bridge.handle({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toBeUndefined();
    expect(
      await bridge.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    ).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
    });
    const observed: unknown[] = [];
    const answer = await bridge.handle(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "echo_tool",
          arguments: { value: "hi" },
          _meta: { "claudecode/toolUseId": "toolu_1" },
        },
      },
      (call, outcome) => observed.push({ call, outcome }),
    );
    expect(answer).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "echo hi" }] },
    });
    expect(observed).toEqual([
      {
        call: { name: "echo_tool", args: { value: "hi" }, callId: "toolu_1" },
        outcome: {
          isError: false,
          result: {
            content: [{ type: "text", text: "echo hi" }],
            details: {
              artifact: {
                type: "image",
                path: "a.png",
                mediaType: "image/png",
              },
            },
          },
        },
      },
    ]);
    expect(
      await bridge.handle({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo_tool", arguments: {} },
      }),
    ).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("Invalid arguments") }],
      },
    });
    expect(
      await bridge.handle({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "fail_tool", arguments: {} },
      }),
    ).toMatchObject({ result: { isError: true, content: [{ text: "Nope" }] } });
    expect(
      await bridge.handle({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "missing", arguments: {} },
      }),
    ).toMatchObject({ result: { isError: true } });
    expect(
      await bridge.handle({ jsonrpc: "2.0", id: 6, method: "nope" }),
    ).toMatchObject({ error: { code: -32601 } });
  });
});

describe("coding agent tool names", () => {
  it("shows every agent's file and shell tools as Pi's, and OhMyGame's tools by their own names", () => {
    expect(
      claudeToolCall("Bash", { command: "ls", description: "List" }),
    ).toEqual({ name: "bash", args: { command: "ls", description: "List" } });
    expect(
      claudeToolCall("Edit", {
        file_path: "a.ts",
        old_string: "x",
        new_string: "y",
      }),
    ).toEqual({ name: "edit", args: { path: "a.ts" } });
    expect(
      claudeToolCall("mcp__ohmygame__generate_image", { prompt: "cat" }),
    ).toEqual({ name: "generate_image", args: { prompt: "cat" } });
    expect(openCodeToolCall("ohmygame_canvas_check", {})).toEqual({
      name: "canvas_check",
      args: {},
    });
    expect(openCodeToolCall("read", { filePath: "a.ts" })).toEqual({
      name: "read",
      args: { path: "a.ts" },
    });
    expect(piToolCall("WebFetch", { url: "https://x" })).toEqual({
      name: "WebFetch",
      args: { url: "https://x" },
    });
    expect(splitModel("anthropic/claude-sonnet-5")).toEqual([
      "anthropic",
      "claude-sonnet-5",
    ]);
    expect(splitModel("openrouter/vendor/model")).toEqual([
      "openrouter",
      "vendor/model",
    ]);
  });
});

describe("coding agent discovery", () => {
  // Windows starts only .exe programs, so it cannot run these script stand-ins, and
  // discovery ignores them there (see docs/agent-runtimes.md).
  it.skipIf(process.platform === "win32")("uses the newest of several installations, unless one was chosen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-binaries-"));
    const install = async (folder: string, version: string) => {
      await mkdir(path.join(root, folder));
      const file = path.join(root, folder, "opencode");
      await writeFile(file, `#!/bin/sh\necho ${version}\n`);
      await chmod(file, 0o755);
      return file;
    };
    // Versions far above any real install, so whatever this computer has does not win.
    const older = await install("old", "98.0.0");
    const newer = await install("new", "99.1.0");
    const previous = process.env.PATH;
    process.env.PATH = [
      path.dirname(older),
      path.dirname(newer),
      previous,
    ].join(path.delimiter);
    try {
      expect((await resolveBinary("opencode-cli"))?.path).toBe(newer);
      expect((await resolveBinary("opencode-cli", older))?.path).toBe(older);
    } finally {
      process.env.PATH = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("orders prereleases by SemVer and retries failed probes without changing the executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-versions-"));
    const install = async (name: string, body: string) => {
      const directory = path.join(root, name);
      await mkdir(directory);
      const binary = path.join(directory, "opencode");
      await writeFile(binary, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
      return binary;
    };
    const stable = await install("stable", "echo 99.1.0");
    const prerelease = await install("prerelease", "echo 99.1.0-alpha.10");
    const flag = path.join(root, "ready");
    const transient = await install(
      "transient",
      `if [ -f '${flag}' ]; then echo 100.0.0; else exit 1; fi`,
    );
    const previous = process.env.PATH;
    process.env.PATH = [stable, prerelease, transient]
      .map(path.dirname)
      .concat(previous ?? "")
      .join(path.delimiter);
    try {
      expect((await resolveBinary("opencode-cli"))?.path).toBe(stable);
      await writeFile(flag, "ready");
      expect((await resolveBinary("opencode-cli"))?.path).toBe(transient);
      await rm(flag);
      expect((await resolveBinary("opencode-cli", undefined, true))?.path).toBe(
        stable,
      );
      expect(
        compareVersions("99.1.0-alpha.10", "99.1.0-alpha.2"),
      ).toBeGreaterThan(0);
      expect(compareVersions("99.1.0+build.2", "99.1.0+build.1")).toBe(0);
      expect(
        compareVersions("99.1.0-alpha-2", "99.1.0-alpha-1"),
      ).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads versions the way each CLI prints them", () => {
    expect(parseVersion("2.1.301 (Claude Code)")).toBe("2.1.301");
    expect(parseVersion("codex-cli 0.147.0")).toBe("0.147.0");
    expect(parseVersion("1.19.3\n")).toBe("1.19.3");
    expect(versionAtLeast("0.147.0", "0.140.0")).toBe(true);
    expect(versionAtLeast("0.99.9", "0.140.0")).toBe(false);
    expect(versionAtLeast("2.0.0", "2.0.0")).toBe(true);
  });

  it("lists OpenCode's tool-calling models with their variants", () => {
    const output = [
      {
        providerID: "opencode",
        id: "big-pickle",
        name: "Big Pickle",
        enabled: true,
        capabilities: { tools: true },
        variants: [{ id: "low" }, { id: "high" }],
        limit: { context: 200000 },
      },
      {
        providerID: "openai",
        id: "text-only",
        enabled: true,
        capabilities: { tools: false },
      },
      {
        providerID: "anthropic",
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        enabled: true,
        capabilities: { tools: true },
      },
      {
        providerID: "x",
        id: "disabled",
        enabled: false,
        capabilities: { tools: true },
      },
      {
        providerID: "x",
        id: "old",
        enabled: true,
        status: "deprecated",
        capabilities: { tools: true },
      },
      { id: "broken" },
    ];
    expect(parseOpenCodeModels(output)).toEqual([
      {
        id: "opencode/big-pickle",
        name: "Big Pickle",
        variants: ["low", "high"],
        contextWindow: 200000,
      },
      {
        id: "anthropic/claude-sonnet-5",
        name: "Claude Sonnet 5",
        variants: [],
      },
    ]);
  });

  it("builds a CLI's environment from an allowlist, without API keys or the daemon's settings", () => {
    const env = agentEnvironment(
      "claude-code-cli",
      "/opt/tools/bin/claude",
      {},
      {
        PATH: "/usr/bin",
        HOME: "/home/me",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        ANTHROPIC_API_KEY: "sk-ant",
        OPENAI_API_KEY: "sk-openai",
        OHMYGAME_DAEMON_TOKEN: "secret",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription",
        CODEX_HOME: "/home/me/.codex",
        OPENCODE_CONFIG_DIR: "/home/me/opencode",
        HTTPS_PROXY: "http://proxy",
      },
    );
    expect(env.PATH!.split(path.delimiter)[0]).toBe("/opt/tools/bin");
    expect(env).toMatchObject({
      HOME: "/home/me",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      HTTPS_PROXY: "http://proxy",
    });
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("OHMYGAME_DAEMON_TOKEN");
    // Another CLI's own folder is not this one's to see.
    expect(env).not.toHaveProperty("CODEX_HOME");
    expect(env).not.toHaveProperty("OPENCODE_CONFIG_DIR");
    expect(
      agentEnvironment(
        "opencode-cli",
        "/opt/bin/opencode",
        {},
        {
          OPENCODE_CONFIG_DIR: "/home/me/opencode",
          OPENCODE_CONFIG: "/home/me/opencode.json",
          OPENCODE_CONFIG_CONTENT: "ignored",
          OPENAI_API_KEY: "ignored",
        },
      ),
    ).toMatchObject({
      OPENCODE_CONFIG_DIR: "/home/me/opencode",
      OPENCODE_CONFIG: "/home/me/opencode.json",
    });
    const nativeEnv = agentEnvironment(
      "opencode-cli",
      "/opt/bin/opencode",
      {},
      {
        OPENCODE_CONFIG_CONTENT: "ignored",
        OPENAI_API_KEY: "ignored",
      },
    );
    expect(nativeEnv).not.toHaveProperty("OPENCODE_CONFIG_CONTENT");
    expect(nativeEnv).not.toHaveProperty("OPENAI_API_KEY");
    // An ohmygame-mcp launcher the CLI may start must not connect back to OhMyGame.
    expect(env.OHMYGAME_EXTERNAL_MCP_DISABLED).toBe("1");
  });
});
