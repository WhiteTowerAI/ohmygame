import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeDriver } from "../src/daemon/agent-runtimes/claude-code.js";
import { CodexDriver } from "../src/daemon/agent-runtimes/codex.js";
import type { DriverContext } from "../src/daemon/agent-runtimes/driver-context.js";
import type { NativeDriver, NativeToolResult, NativeTurnSink } from "../src/daemon/agent-runtimes/native-session.js";
import { setAgentProcessSpawner, stopAgentProcesses } from "../src/daemon/agent-runtimes/process.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import { readTranscript, replaySpawner } from "./agent-transcripts.js";

const DRIVERS: Record<string, (context: DriverContext) => NativeDriver> = {
  "claude-code-cli": (context) => new ClaudeCodeDriver(context),
  "codex-cli": (context) => new CodexDriver(context),
};

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await stopAgentProcesses();
  setAgentProcessSpawner(undefined);
});

/** What the adapter reported, without the streamed pieces: the shape a change to an adapter shows in review. */
interface Reported {
  outcome: unknown;
  texts: string[];
  tools: Array<{ callId: string; name: string; args: Record<string, unknown>; result?: { isError: boolean; text: string } }>;
  plans: string[];
  approvals: unknown[];
}

function text(result: NativeToolResult): string {
  return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").slice(0, 400);
}

async function replay(runtime: string, scenario: string): Promise<Reported> {
  const fixture = path.join(import.meta.dirname, "fixtures", "agent-transcripts", runtime, `${scenario}.ndjson`);
  const transcript = await readTranscript(fixture);
  const played = replaySpawner(transcript, setAgentProcessSpawner);
  const privateDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-replay-"));
  cleanup.push(() => rm(privateDirectory, { recursive: true, force: true }));
  const driver = DRIVERS[runtime]!({
    binaryPath: "/usr/local/bin/fake",
    workspacePath: transcript.header.workspacePath,
    env: {},
    privateDirectory,
    instructions: "",
    bridge: new ToolBridge([]),
    permissionMode: transcript.header.permissionMode as DriverContext["permissionMode"],
    skillDirectories: [],
    model: transcript.header.model,
  });
  cleanup.push(() => driver.dispose());
  const reported: Reported = { outcome: undefined, texts: [], tools: [], plans: [], approvals: [] };
  const sink: NativeTurnSink = {
    text: () => {},
    textDone: (_key, value) => { if (value) reported.texts.push(value); },
    thinking: () => {},
    thinkingDone: () => {},
    toolCall: (callId, name, args) => { reported.tools.push({ callId, name, args }); },
    toolStarted: () => {},
    toolUpdate: () => {},
    toolResult: (callId, result, isError) => {
      const tool = reported.tools.find((item) => item.callId === callId);
      if (tool) tool.result = { isError, text: text(result) };
    },
    proposedPlan: (_callId, markdown) => { reported.plans.push(markdown); },
    usage: () => {},
    spent: () => {},
    compaction: () => {},
    nativeSession: () => {},
    requestUserInput: async () => { throw new Error("The recorded turn asked no question"); },
    requestApproval: async (details) => {
      reported.approvals.push(details);
      return "deny";
    },
  };
  reported.outcome = await driver.runTurn(
    { text: transcript.header.prompt, images: [], readOnly: transcript.header.readOnly },
    sink,
    new AbortController().signal,
  );
  expect(played.unexpected, "lines the adapter wrote that the CLI never received").toEqual([]);
  expect(played.missing(), "lines the CLI received that the adapter did not write").toEqual([]);
  await expect(JSON.stringify(reported, null, 2) + "\n").toMatchFileSnapshot(fixture.replace(/\.ndjson$/, ".reported.json"));
  return reported;
}

describe("recorded Claude Code turns", () => {
  it("edits one file and writes another with full access", async () => {
    const reported = await replay("claude-code-cli", "edit");
    expect(reported.outcome).toEqual({ status: "completed" });
    expect(reported.tools.map(({ name, args, result }) => ({ name, file: path.basename(String(args.path)), failed: result?.isError })))
      .toEqual(expect.arrayContaining([
        { name: "edit", file: "hello.txt", failed: false },
        { name: "write", file: "notes.md", failed: false },
      ]));
    expect(reported.approvals).toEqual([]);
  });

  it("plans in plan mode and shows ExitPlanMode's plan as the proposed plan", async () => {
    const reported = await replay("claude-code-cli", "plan");
    expect(reported.outcome).toEqual({ status: "completed" });
    expect(reported.plans).toHaveLength(1);
    expect(reported.plans[0]).toMatch(/score/i);
    // Claude Code writes its plan file in its own folder; nothing in the project changes.
    const changed = reported.tools.filter(({ name }) => name === "edit" || name === "write").map(({ args }) => String(args.path));
    expect(changed.filter((file) => file.includes("ohmygame-transcript/workspace"))).toEqual([]);
  });
});

describe("recorded Codex turns", () => {
  it("edits one file and writes another with full access", async () => {
    const reported = await replay("codex-cli", "edit");
    expect(reported.outcome).toEqual({ status: "completed" });
    const edits = reported.tools.filter(({ name }) => name === "edit");
    expect(edits.flatMap(({ args }) => (args.files as string[] | undefined) ?? [String(args.path)]).map((file) => path.basename(file)).sort())
      .toEqual(["hello.txt", "notes.md"]);
    expect(edits.every(({ result }) => result?.isError === false)).toBe(true);
    expect(reported.approvals).toEqual([]);
  });

  it("plans in its Plan mode and shows the plan item as the proposed plan", async () => {
    const reported = await replay("codex-cli", "plan");
    expect(reported.outcome).toEqual({ status: "completed" });
    expect(reported.plans).toHaveLength(1);
    expect(reported.plans[0]).toMatch(/score/i);
    expect(reported.tools.some(({ name }) => name === "edit" || name === "write")).toBe(false);
  });
});
