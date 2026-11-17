// Runs the Plugin Builder's agent on a fixed set of requests against a
// running daemon, with the model it is set up to use, and checks what each
// workspace's draft ends up as. It measures the builder's prompt and the
// plugin-creator Skill: run it before and after changing either and compare.
// It needs a real model, so it isn't part of `bun run test` or CI.
//
//   bun run eval:plugin-builder                 every case
//   bun run eval:plugin-builder panel tool      only these cases
//   --keep                                      keep the workspaces to look at
//   --out results.json                          write the results as JSON
//
// OHMYGAME_DAEMON_URL (default http://127.0.0.1:43110) and, for a daemon
// that wants one, OHMYGAME_DAEMON_TOKEN say which daemon to use.

import { writeFile } from "node:fs/promises";

interface Draft {
  path?: string;
  errors: string[];
  plugin?: {
    id: string;
    icon?: unknown;
    examples: string[];
    adds: Record<string, unknown>;
    native?: { tools: unknown[]; commands: unknown[]; hooks: unknown[] };
  };
}

interface Case {
  id: string;
  prompt: string;
  /** What a good draft has, beyond passing its checks. */
  expect: (draft: Draft) => string[];
}

const adds = (draft: Draft, kind: string): number => {
  const value = draft.plugin?.adds[kind];
  return Array.isArray(value) ? value.length : typeof value === "number" ? value : 0;
};
const has = (condition: boolean, problem: string): string[] => condition ? [] : [problem];

const CASES: Case[] = [
  {
    id: "skill",
    prompt: "Make a Skill that teaches the agent to write a short changelog entry for each gameplay change it makes.",
    expect: (draft) => has(adds(draft, "skills") > 0, "adds no Skill"),
  },
  {
    // The request #725 found refused.
    id: "panel",
    prompt: "Make a panel in the project workspace that shows a daily quote.",
    expect: (draft) => [...has(adds(draft, "panels") > 0, "adds no panel"), ...has(Boolean(draft.plugin?.icon), "has no icon, which a panel's tab needs")],
  },
  {
    id: "tool",
    prompt: "Make a tool the agent can call to count the lines of every .ts file in the project.",
    expect: (draft) => has(Boolean(draft.plugin?.native?.tools.length), "has no native tool"),
  },
  {
    id: "hook",
    prompt: "Make a hook that shows a notice with how many files changed whenever an agent turn ends.",
    expect: (draft) => has(Boolean(draft.plugin?.native?.hooks.length), "hears no hook"),
  },
  {
    id: "panel-files",
    prompt: "Make a panel that lists the project's image files with their sizes and lets me open one.",
    expect: (draft) => has(adds(draft, "panels") > 0, "adds no panel"),
  },
];

const base = (process.env.OHMYGAME_DAEMON_URL ?? "http://127.0.0.1:43110").replace(/\/$/, "");
const token = process.env.OHMYGAME_DAEMON_TOKEN;
/** The longest one case may take, including the agent's whole turn. */
const CASE_TIMEOUT_MS = 15 * 60_000;

async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

interface Result {
  id: string;
  ok: boolean;
  seconds: number;
  problems: string[];
  plugin?: string;
  workspace: string;
}

async function runCase(item: Case, keep: boolean): Promise<Result> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  let workspace: { id: string; projectId: string };
  try {
    workspace = await call("POST", "/plugins/setup-sessions", {});
  } catch (cause) {
    return { id: item.id, ok: false, seconds: seconds(), problems: [cause instanceof Error ? cause.message : String(cause)], workspace: "" };
  }
  let turn: { conversation: string; id: string } | undefined;
  try {
    const conversation = await call<{ id: string }>("POST", `/projects/${workspace.projectId}/conversations`, {});
    const sent = await call<{ turnId: string }>("POST", `/projects/${workspace.projectId}/conversations/${conversation.id}/turns`, { prompt: item.prompt });
    turn = { conversation: conversation.id, id: sent.turnId };
    // The workspace is working while its project's agent is.
    for (;;) {
      if (Date.now() - started > CASE_TIMEOUT_MS) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const summary = await call<{ status: string }>("GET", `/plugins/setup-sessions/${workspace.id}`);
      if (summary.status !== "working") break;
    }
    const draft = await call<Draft>("GET", `/plugins/setup-sessions/${workspace.id}/draft`);
    const problems = [
      ...has(Boolean(draft.path), "never prepared a draft"),
      ...draft.errors.map((error) => `check: ${error}`),
      ...has(Boolean(draft.plugin?.id.startsWith("personal/")), "is not a personal plugin"),
      ...has(Boolean(draft.plugin?.examples.length), "gives no examples to try it with"),
      ...(draft.plugin ? item.expect(draft) : []),
    ];
    return { id: item.id, ok: !problems.length, seconds: seconds(), problems, plugin: draft.plugin?.id, workspace: workspace.id };
  } catch (cause) {
    // A turn still running keeps using the model, and its workspace can't be deleted, so it stops first.
    if (turn) await stopTurn(workspace, turn);
    return { id: item.id, ok: false, seconds: seconds(), problems: [cause instanceof Error ? cause.message : String(cause)], workspace: workspace.id };
  } finally {
    if (!keep) await call("DELETE", `/plugins/setup-sessions/${workspace.id}`).catch((cause: unknown) =>
      console.warn(`Couldn't delete workspace ${workspace.id}: ${cause instanceof Error ? cause.message : String(cause)}`));
  }
}

/** Cancels a turn and waits, briefly, for its workspace to stop working. */
async function stopTurn(workspace: { id: string; projectId: string }, turn: { conversation: string; id: string }): Promise<void> {
  await call("POST", `/projects/${workspace.projectId}/conversations/${turn.conversation}/turns/${turn.id}/cancel`).catch(() => {});
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const summary = await call<{ status: string }>("GET", `/plugins/setup-sessions/${workspace.id}`).catch(() => undefined);
    if (summary?.status !== "working") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (outIndex >= 0 && !out) throw new Error("--out needs a file");
  const names = args.filter((arg, index) => !arg.startsWith("--") && (outIndex < 0 || index !== outIndex + 1));
  const unknown = names.filter((name) => !CASES.some((item) => item.id === name));
  if (unknown.length) throw new Error(`No such case: ${unknown.join(", ")}. Cases: ${CASES.map((item) => item.id).join(", ")}`);
  const cases = names.length ? CASES.filter((item) => names.includes(item.id)) : CASES;
  const results: Result[] = [];
  // One at a time: they share the model's rate limits, and a slow case shouldn't starve another.
  for (const item of cases) {
    process.stdout.write(`${item.id} … `);
    const result = await runCase(item, keep);
    results.push(result);
    console.log(`${result.ok ? "pass" : "FAIL"} (${result.seconds}s)${result.problems.length ? `\n  - ${result.problems.join("\n  - ")}` : ""}`);
  }
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (out) await writeFile(out, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

await main();
