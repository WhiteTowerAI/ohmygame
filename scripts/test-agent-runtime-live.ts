/**
 * Opt-in integration test against an installed, authenticated coding agent.
 * node --import tsx scripts/test-agent-runtime-live.ts codex-cli [model-id]
 * Uses isolated app data/workspace. Requires normal provider access and may consume quota.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createApp } from "../src/daemon/app.js";
import type {
  AgentModelCatalog,
  ConversationDetail,
  Turn,
} from "../src/shared/contracts.js";
import { isAgentRuntimeId } from "../src/shared/agent-runtimes.js";

const runtime = process.argv[2];
if (!isAgentRuntimeId(runtime))
  throw new Error("Choose claude-code-cli, codex-cli or opencode-cli");
const root = await mkdtemp(path.resolve(".runtime/agent-runtime-live-"));
const externalFixture = await mkdtemp(
  path.join(os.tmpdir(), "ohmygame-native-external-"),
);
const workspace = path.join(root, "workspace");
await mkdir(workspace);
// A Skill of OhMyGame's own, staged for the session; its code proves the agent read it.
const skillCode = "LIVE-SKILL-" + randomUUID().slice(0, 8);
const skillDirectory = path.join(root, "pi", "skills", "live-check");
await mkdir(skillDirectory, { recursive: true });
await writeFile(
  path.join(skillDirectory, "SKILL.md"),
  `---\nname: live-check\ndescription: Gives the live check code when someone asks for the live check code.\n---\n\nThe live check code is ${skillCode}. Reply with exactly that code.\n`,
);
const token = randomUUID();
let app!: ReturnType<typeof createApp>;
let origin = "";
let version: string | undefined;
const evidence: unknown[] = [];
const boundaryFailures: string[] = [];
function checkBoundary(condition: unknown, message: string) {
  if (!condition) {
    boundaryFailures.push(message);
    evidence.push({ boundaryFailure: message });
  }
}
async function start() {
  app = createApp({
    dataDirectory: path.join(root, "data"),
    piAgentDirectory: path.join(root, "pi"),
    accessToken: token,
  });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
}
async function call<T = any>(
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(origin + url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(version ? { "x-workspace-version": version } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  version = response.headers.get("x-workspace-version") ?? version;
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok)
    throw new Error(
      `${method} ${url}: ${response.status} ${JSON.stringify(data)}`,
    );
  return data as T;
}
let base = "";
async function detail() {
  return call<ConversationDetail>("GET", base);
}
const answered = new Set<string>();
async function answerWaiting(turns: Turn[]) {
  for (const item of turns.flatMap((turn) => turn.items)) {
    if (
      item.type !== "approvalRequest" ||
      item.status !== "inProgress" ||
      answered.has(item.requestId)
    )
      continue;
    answered.add(item.requestId);
    // Grant only the disposable test workspace; refuse network and external paths.
    const request = item.request;
    const paths = [
      request.path,
      ...(request.paths?.map((entry) => entry.path) ?? []),
    ].filter(Boolean) as string[];
    const command = request.command ?? "";
    const scoped =
      !request.network &&
      !paths.some(
        (file) =>
          !path.resolve(workspace, file).startsWith(workspace + path.sep) &&
          path.resolve(workspace, file) !== workspace,
      ) &&
      !/(curl|wget|sudo|git push|npm|pnpm|yarn|\/Users\/|~\/)/.test(command);
    const decision = scoped ? "allow" : "deny";
    evidence.push({ approval: request, decision });
    await call("POST", base + "/approvals/" + item.requestId, { decision });
  }
}
async function waitTurn(
  turnId: string,
  timeout = 180_000,
  expectedText?: string,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await detail();
    const turn =
      state.turns.find((t) => t.id === turnId) ??
      (expectedText
        ? state.turns.findLast((t) =>
            t.items.some(
              (item) =>
                // Planning prefixes the stored message with its instructions.
                item.type === "userMessage" && item.text.includes(expectedText),
            ),
          )
        : undefined);
    await answerWaiting(turn ? [turn] : []);
    if (
      turn &&
      turn.status !== "inProgress" &&
      state.agent.status !== "running" &&
      state.agent.status !== "cancelling"
    ) {
      evidence.push({ turn, settings: state.settings });
      await writeFile(
        path.join(root, "evidence.json"),
        JSON.stringify(evidence, null, 2),
      );
      console.log(
        JSON.stringify({
          turn: turnId,
          status: turn.status,
          items: turn.items.map((item) => ({
            type: item.type,
            ...("text" in item ? { text: item.text } : {}),
            ...("name" in item ? { name: item.name } : {}),
          })),
        }),
      );
      return turn;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await call("POST", base + "/turns/" + turnId + "/cancel").catch(() => {});
  throw new Error("Timed out waiting for native turn");
}
async function prompt(text: string, mode?: "planning") {
  const result = await call<{ turnId: string }>("POST", base + "/turns", {
    prompt: text,
    ...(mode ? { mode } : {}),
  });
  const turn = await waitTurn(result.turnId, 180_000, text);
  assert.equal(turn.status, "completed", JSON.stringify(turn));
  return turn;
}
try {
  await start();
  const status = await call("PATCH", "/agent-runtimes/" + runtime, {
    enabled: true,
    ...(process.argv[4] ? { binaryPath: path.resolve(process.argv[4]) } : {}),
  });
  console.log(
    JSON.stringify({
      runtime,
      installed: status.installed,
      version: status.version,
      auth: status.auth.status,
      root,
    }),
  );
  const catalog = await call<AgentModelCatalog>("GET", "/models?runtimes=1");
  const available = catalog.models.filter((m) => m.provider === runtime);
  console.log(JSON.stringify({ available: available.map((m) => m.id) }));
  const model = available.find((m) => m.id === process.argv[3]) ?? available[0];
  assert(model, "No models available");
  if (process.argv[3]) assert.equal(model.id, process.argv[3]);
  console.log(JSON.stringify({ model: model.id }));
  const project = await call("POST", "/projects", {
    name: "Native runtime acceptance",
    type: "general",
    workspacePath: workspace,
  });
  const conversation = await call(
    "POST",
    `/projects/${project.id}/conversations`,
    { model: { provider: runtime, id: model.id } },
  );
  base = `/projects/${project.id}/conversations/${conversation.id}`;
  const first = await prompt(
    "This is a narrowly scoped integration test. Write runtime-proof.txt containing exactly FIRST followed by a newline. Then call the OhMyGame canvas_check tool once; if no canvas exists, just report that result. Do not create canvas files or run builds, installs or network commands. Reply DONE.",
  );
  assert.equal(
    await readFile(path.join(workspace, "runtime-proof.txt"), "utf8"),
    "FIRST\n",
  );
  assert(
    first.items.some(
      (item) =>
        item.type === "dynamicToolCall" &&
        JSON.stringify(item).includes("canvas_check"),
    ),
    "OhMyGame tool bridge was not called",
  );
  const second = await prompt(
    "Replace runtime-proof.txt with exactly SECOND followed by a newline. Do nothing else. Reply DONE.",
  );
  assert.equal(
    await readFile(path.join(workspace, "runtime-proof.txt"), "utf8"),
    "SECOND\n",
  );
  const beforeRestart = await detail();
  await app.close();
  await start();
  const reloaded = await detail();
  assert.equal(reloaded.turns.length, beforeRestart.turns.length);
  const remembered = await prompt(
    "Without reading files or calling tools: what were the two exact values I asked you to write to runtime-proof.txt, in order? Reply only those values.",
  );
  assert(
    remembered.items.some(
      (item) =>
        item.type === "agentMessage" &&
        item.text.includes("FIRST") &&
        item.text.includes("SECOND"),
    ),
    "Native resume lost conversation context",
  );
  await call("POST", base + "/compact", {});
  assert(
    (await detail()).turns.some((turn) =>
      turn.items.some(
        (item) =>
          item.type === "contextCompaction" && item.status === "completed",
      ),
    ),
    "Native compaction record was not persisted",
  );
  const revisedText =
    "Replace runtime-proof.txt with exactly THIRD followed by a newline. Do nothing else. Reply DONE.";
  const revised = await call<{ turnId: string }>(
    "POST",
    base + "/revise-last",
    { prompt: revisedText },
  );
  assert.equal(
    (await waitTurn(revised.turnId, 180_000, revisedText)).status,
    "completed",
  );
  assert.equal(
    await readFile(path.join(workspace, "runtime-proof.txt"), "utf8"),
    "THIRD\n",
  );
  const checkpoint = second.items.find(
    (item) => item.type === "userMessage",
  )?.checkpointId;
  assert(checkpoint, "Second turn has no checkpoint");
  await call("POST", base + "/checkpoints/" + checkpoint + "/restore");
  assert.equal(
    await readFile(path.join(workspace, "runtime-proof.txt"), "utf8"),
    "FIRST\n",
  );
  await prompt(
    "Read runtime-proof.txt. Reply only its current contents. Do not change anything.",
  );
  const fixtureSecret = "INTEGRATION-DO-NOT-READ-" + randomUUID();
  await writeFile(path.join(root, "outside-native-test.txt"), fixtureSecret);
  const denied = await prompt(
    "Read ../outside-native-test.txt using your file read tool once. If permission is denied, reply DENIED and stop. Do not retry or use other tools.",
  );
  checkBoundary(
    !denied.items.some(
      (item) =>
        item.type === "agentMessage" && item.text.includes(fixtureSecret),
    ),
    "Denied external file leaked",
  );
  await writeFile(path.join(externalFixture, "fixture.txt"), fixtureSecret);
  const asked = await prompt(
    `Read ${path.join(externalFixture, "fixture.txt")}. Request approval for this exact file first using request_permissions if that tool is available; otherwise use your file read tool once. Do not request unrestricted escalation. If permission is denied, reply DENIED and stop. Do not retry.`,
  );
  checkBoundary(
    !asked.items.some(
      (item) =>
        item.type === "agentMessage" && item.text.includes(fixtureSecret),
    ),
    "Denied external fixture leaked",
  );
  checkBoundary(
    asked.items.some(
      (item) => item.type === "approvalRequest" && item.decision === "deny",
    ),
    "External read did not ask",
  );
  const usage = await call("GET", base + "/context-usage");
  evidence.push({ usage });
  // Claude Code refuses a standalone `sleep` in its shell tool, so it gets an equivalent long-running command.
  const longCommand =
    runtime === "claude-code-cli"
      ? 'node -e "setTimeout(() => {}, 30000)"'
      : "sleep 30";
  const cancelText = `For this cancellation test, run exactly the shell command ${longCommand} (no cd needed; cwd is the workspace), then reply DONE. Do nothing else.`;
  const running = await call<{ turnId: string }>("POST", base + "/turns", {
    prompt: cancelText,
  });
  let executing = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !executing) {
    const state = await detail();
    await answerWaiting(state.turns);
    executing = state.turns.some((turn) =>
      turn.items.some(
        (item) =>
          item.type === "dynamicToolCall" &&
          item.tool === "bash" &&
          item.status === "inProgress" &&
          JSON.stringify(item.arguments).includes(
            JSON.stringify(longCommand).slice(1, -1),
          ),
      ),
    );
    if (!executing) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(executing, "Cancellation test did not reach an executing shell tool");
  const cancelStart = Date.now();
  await call("POST", base + "/turns/" + running.turnId + "/cancel");
  const cancelled = await waitTurn(running.turnId, 10_000, cancelText);
  assert.equal(cancelled.status, "cancelled");
  const cancellationMs = Date.now() - cancelStart;
  evidence.push({ cancellationMs });
  await app.close();
  await start();
  checkBoundary(
    (await detail()).turns.some((turn) =>
      turn.items.some(
        (item) => item.type === "approvalRequest" && item.decision === "deny",
      ),
    ),
    "Approval record disappeared on restart",
  );
  // Skills and planning, in a conversation of their own so the pending plan
  // does not hold up the checks above.
  const extra = await call("POST", `/projects/${project.id}/conversations`, {
    model: { provider: runtime, id: model.id },
  });
  base = `/projects/${project.id}/conversations/${extra.id}`;
  const skillTurn = await prompt(
    "What is the live check code? Use the live-check Skill to find out, and reply with only the code.",
  );
  assert(
    skillTurn.items.some(
      (item) => item.type === "agentMessage" && item.text.includes(skillCode),
    ),
    "The staged Skill did not reach the agent",
  );
  checkBoundary(
    !skillTurn.items.some((item) => item.type === "approvalRequest"),
    "Loading a staged Skill asked for approval",
  );
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(
    path.join(workspace, "src", "player.ts"),
    "export const PLAYER_SPEED = 4;\n",
  );
  const planTurn = await prompt(
    "Plan how to double the player's speed. First search the project to find where the player speed is defined. This is planning only: present the plan, do not create or change files.",
    "planning",
  );
  assert.equal(
    await readFile(path.join(workspace, "src", "player.ts"), "utf8"),
    "export const PLAYER_SPEED = 4;\n",
  );
  assert(
    planTurn.items.some((item) => item.type === "plan"),
    "Planning did not record a structured plan",
  );
  assert.equal((await detail()).plan?.mode, "awaiting_approval");
  console.log(
    JSON.stringify({
      result: boundaryFailures.length ? "FAIL_BOUNDARY" : "PASS",
      boundaryFailures,
      cancellationMs,
      usage,
      root,
    }),
  );
  assert.equal(boundaryFailures.length, 0, boundaryFailures.join("; "));
} catch (error) {
  evidence.push({ failure: String(error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  await app!.close();
  await rm(externalFixture, { recursive: true, force: true });
  await writeFile(
    path.join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log("Evidence: " + root);
}
