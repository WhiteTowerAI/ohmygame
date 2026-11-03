import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_USAGE_ENTRY } from "../src/daemon/agent-runtimes/native-session.js";
import { NATIVE_API } from "../src/daemon/agent-runtimes/replay.js";
import { sessionDirectory } from "../src/daemon/conversations.js";
import { UsageIndex } from "../src/daemon/usage-stats.js";
import type { ProjectState } from "../src/shared/contracts.js";
import {
  localDate,
  shiftDate,
  summarizeUsage,
  usageHeatmap,
  type UsageStats,
} from "../src/shared/usage-stats.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const NOW = new Date(2026, 10, 2, 12).getTime();

describe("UsageIndex", () => {
  // Entries take the time they are written; each step sets the clock to the moment it describes.
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("adds up the agent's responses and turns by day, project and model", async () => {
    const project = await createProject("Dungeon");
    const session = SessionManager.create(
      project.workspacePath,
      sessionDirectory(project),
    );
    ask(session, NOW - DAY);
    respond(session, {
      at: NOW - DAY + 2 * MINUTE,
      input: 100,
      output: 20,
      cacheRead: 900,
    });
    ask(session, NOW);
    respond(session, {
      at: NOW + MINUTE,
      input: 50,
      output: 10,
      cacheRead: 450,
    });
    respond(session, {
      at: NOW + 3 * MINUTE,
      model: "local",
      provider: "ollama",
      input: 30,
      output: 5,
    });

    const stats = await new UsageIndex(() => [project]).stats();

    expect(stats.projects).toEqual([{ id: project.id, name: "Dungeon" }]);
    expect(stats.rows).toEqual([
      expect.objectContaining({
        date: localDate(NOW - DAY),
        projectId: project.id,
        provider: "anthropic",
        model: "claude-opus-5-5",
        input: 100,
        output: 20,
        cacheRead: 900,
        turns: 1,
        durationMs: 2 * MINUTE,
      }),
      expect.objectContaining({
        date: localDate(NOW),
        provider: "anthropic",
        input: 50,
        output: 10,
        turns: 0,
      }),
      // A turn belongs to the model that answered last in it.
      expect.objectContaining({
        date: localDate(NOW),
        provider: "ollama",
        model: "local",
        input: 30,
        turns: 1,
        durationMs: 3 * MINUTE,
      }),
    ]);
  });

  it("leaves long waits out of a turn's time", async () => {
    const project = await createProject();
    const session = SessionManager.create(
      project.workspacePath,
      sessionDirectory(project),
    );
    ask(session, NOW);
    respond(session, { at: NOW + 2 * MINUTE, input: 10, output: 1 });
    // An approval that waited for an hour counts as the longest pause allowed.
    respond(session, { at: NOW + 62 * MINUTE, input: 10, output: 1 });

    const stats = await new UsageIndex(() => [project]).stats();

    expect(stats.rows[0]).toMatchObject({ turns: 1, durationMs: 17 * MINUTE });
  });

  it("counts a response copied into a branch once, and keeps archived conversations", async () => {
    const project = await createProject();
    const session = SessionManager.create(
      project.workspacePath,
      sessionDirectory(project),
    );
    ask(session, NOW);
    const entry = respond(session, {
      at: NOW + MINUTE,
      input: 100,
      output: 10,
    });
    session.createBranchedSession(entry);
    const files = await readdir(sessionDirectory(project));
    expect(files.filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
    await mkdir(path.join(sessionDirectory(project), "archived"));
    await rename(
      path.join(sessionDirectory(project), files[0]!),
      path.join(sessionDirectory(project), "archived", files[0]!),
    );

    const stats = await new UsageIndex(() => [project]).stats();

    expect(stats.rows).toEqual([
      expect.objectContaining({
        input: 100,
        output: 10,
        turns: 1,
        durationMs: MINUTE,
      }),
    ]);
  });

  it("counts coding agents from their usage entries, not their messages", async () => {
    const project = await createProject();
    const session = SessionManager.create(
      project.workspacePath,
      sessionDirectory(project),
    );
    ask(session, NOW);
    // Stored messages repeat the latest request's usage for the context meter.
    respond(session, {
      at: NOW + MINUTE,
      api: NATIVE_API,
      provider: "codex",
      model: "gpt-5",
      input: 5000,
      output: 500,
    });
    session.appendCustomEntry(NATIVE_USAGE_ENTRY, {
      version: 1,
      runtime: "codex",
      model: "gpt-5",
      input: 300,
      output: 40,
      cacheRead: 4700,
      cacheWrite: 0,
      at: NOW + MINUTE,
    });
    respond(session, {
      at: NOW + 2 * MINUTE,
      api: NATIVE_API,
      provider: "codex",
      model: "gpt-5",
      input: 5000,
      output: 500,
    });
    // Before usage entries, a coding agent's turn still counts its time.
    ask(session, NOW + 10 * MINUTE);
    respond(session, {
      at: NOW + 14 * MINUTE,
      api: NATIVE_API,
      provider: "claude-code-cli",
      model: "sonnet",
      input: 9,
      output: 9,
    });

    const stats = await new UsageIndex(() => [project]).stats();

    expect(stats.rows).toEqual([
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5",
        input: 300,
        output: 40,
        cacheRead: 4700,
        turns: 1,
        durationMs: 2 * MINUTE,
      }),
      expect.objectContaining({
        provider: "claude-code-cli",
        model: "sonnet",
        input: 0,
        output: 0,
        turns: 1,
        durationMs: 4 * MINUTE,
      }),
    ]);
  });

  it("leaves a turn's time alone when the conversation is renamed later", async () => {
    const project = await createProject();
    const session = SessionManager.create(
      project.workspacePath,
      sessionDirectory(project),
    );
    ask(session, NOW);
    respond(session, { at: NOW + MINUTE, input: 10, output: 1 });
    vi.setSystemTime(NOW + DAY);
    session.appendSessionInfo("Renamed");
    session.appendModelChange("ollama", "local");

    const stats = await new UsageIndex(() => [project]).stats();

    expect(stats.rows[0]).toMatchObject({ turns: 1, durationMs: MINUTE });
  });

  it("counts a coding agent's entry whose time comes after a long model name", async () => {
    const project = await createProject();
    const session = SessionManager.create(
      project.workspacePath,
      sessionDirectory(project),
    );
    ask(session, NOW);
    respond(session, {
      at: NOW + MINUTE,
      api: NATIVE_API,
      provider: "codex-cli",
      model: "gpt-5",
      input: 1,
      output: 1,
    });
    const model = `gpt-5-${"x".repeat(500)}`;
    vi.setSystemTime(NOW + 2 * MINUTE);
    session.appendCustomEntry(NATIVE_USAGE_ENTRY, {
      version: 1,
      runtime: "codex-cli",
      model,
      input: 70,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      at: NOW + 2 * MINUTE,
    });

    const stats = await new UsageIndex(() => [project]).stats();

    expect(stats.rows).toEqual([
      expect.objectContaining({
        model,
        input: 70,
        output: 7,
        turns: 1,
        durationMs: 2 * MINUTE,
      }),
    ]);
  });

  it("reads a file again when it changed without growing", async () => {
    const project = await createProject();
    const session = SessionManager.create(
      project.workspacePath,
      sessionDirectory(project),
    );
    ask(session, NOW);
    respond(session, { at: NOW + MINUTE, input: 100, output: 1 });
    respond(session, { at: NOW + 2 * MINUTE, input: 5, output: 1 });
    const index = new UsageIndex(() => [project]);
    expect((await index.stats()).rows[0]).toMatchObject({ input: 105 });

    const [name] = await readdir(sessionDirectory(project));
    const file = path.join(sessionDirectory(project), name!);
    // The same length and the same last bytes, but an earlier number changed.
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace('"input":100', '"input":900'),
    );
    await utimes(file, new Date(NOW + DAY), new Date(NOW + DAY));

    expect((await index.stats()).rows[0]).toMatchObject({ input: 905 });
  });

  it("follows lines longer than the chunks it reads", async () => {
    const project = await createProject();
    const session = SessionManager.create(
      project.workspacePath,
      sessionDirectory(project),
    );
    ask(session, NOW);
    respond(session, { at: NOW + MINUTE, input: 10, output: 1 });
    // A pasted file or tool output can make one line many megabytes long.
    vi.setSystemTime(NOW + 2 * MINUTE);
    session.appendMessage({
      role: "user",
      content: "x".repeat(9 * 1024 * 1024),
      timestamp: NOW + 2 * MINUTE,
    } as never);
    respond(session, { at: NOW + 4 * MINUTE, input: 20, output: 2 });

    const stats = await new UsageIndex(() => [project]).stats();

    expect(stats.rows).toEqual([
      expect.objectContaining({
        input: 30,
        output: 3,
        turns: 2,
        durationMs: 3 * MINUTE,
      }),
    ]);
  });

  it("reads only what a session file gained since the last look", async () => {
    const project = await createProject();
    const session = SessionManager.create(
      project.workspacePath,
      sessionDirectory(project),
    );
    ask(session, NOW);
    respond(session, { at: NOW + MINUTE, input: 10, output: 1 });
    const index = new UsageIndex(() => [project]);
    expect((await index.stats()).rows[0]).toMatchObject({
      input: 10,
      turns: 1,
      durationMs: MINUTE,
    });

    respond(session, { at: NOW + 2 * MINUTE, input: 20, output: 2 });
    // A line still being written is left for the next look.
    const [file] = await readdir(sessionDirectory(project));
    await appendFile(
      path.join(sessionDirectory(project), file!),
      '{"type":"message","message":{"role":"assistant","usage"',
    );

    expect((await index.stats()).rows[0]).toMatchObject({
      input: 30,
      output: 3,
      turns: 1,
      durationMs: 2 * MINUTE,
    });
  });
});

describe("summarizeUsage", () => {
  const today = localDate(NOW);
  const stats: UsageStats = {
    projects: [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ],
    providers: [{ id: "p", name: "My relay" }],
    rows: [
      row(shiftDate(today, -40), "a", "m1", 1000),
      row(shiftDate(today, -2), "a", "m1", 300),
      row(shiftDate(today, -1), "b", "m2", 500),
      row(today, "b", "m1", 100),
    ],
  };

  it("keeps the period's rows and ranks models and projects by tokens", () => {
    const summary = summarizeUsage(stats, "7d", today);

    expect(summary.totals).toMatchObject({
      input: 900,
      turns: 3,
      durationMs: 3 * MINUTE,
    });
    expect(
      summary.models.map((group) => [
        group.label,
        group.providerName,
        group.input,
      ]),
    ).toEqual([
      ["m2", "My relay", 500],
      ["m1", "My relay", 400],
    ]);
    expect(summary.projects.map((group) => [group.label, group.input])).toEqual(
      [
        ["Beta", 600],
        ["Alpha", 300],
      ],
    );
    expect(summary.activeDays).toBe(3);
    expect(summarizeUsage(stats, "all", today).totals.input).toBe(1900);
  });

  it("names coding agents and leaves a removed custom provider unnamed", () => {
    const named = summarizeUsage(
      {
        projects: [],
        rows: [
          { ...row(today, "a", "sonnet", 30), provider: "claude-code-cli" },
          { ...row(today, "a", "gpt", 20), provider: "custom-04f185aa" },
          { ...row(today, "a", "local", 10), provider: "ollama" },
        ],
      },
      "7d",
      today,
    );

    expect(named.models.map((group) => group.providerName)).toEqual([
      "Claude Code",
      undefined,
      "ollama",
    ]);
  });

  it("counts streaks over all days, carrying today's until it has use", () => {
    expect(summarizeUsage(stats, "7d", today)).toMatchObject({
      currentStreak: 3,
      longestStreak: 3,
    });
    const yesterday = {
      ...stats,
      rows: stats.rows.filter((value) => value.date !== today),
    };
    expect(summarizeUsage(yesterday, "7d", today).currentStreak).toBe(2);
  });

  it("lays out weeks from Sunday with today in the last one", () => {
    const days = new Map([
      [today, 100],
      [shiftDate(today, -1), 10],
    ]);
    const weeks = usageHeatmap(days, today, 2);

    expect(weeks).toHaveLength(2);
    expect(new Date(`${weeks[0]![0]!.date}T12:00`).getDay()).toBe(0);
    const cells = weeks.flat();
    expect(cells.find((cell) => cell.date === today)).toMatchObject({
      tokens: 100,
      level: 4,
      future: false,
    });
    expect(
      cells.find((cell) => cell.date === shiftDate(today, -1))?.level,
    ).toBe(1);
    expect(cells.at(-1)!.date >= today).toBe(true);
    expect(
      cells
        .filter((cell) => cell.future)
        .every((cell) => cell.tokens === 0 && cell.level === 0),
    ).toBe(true);
  });
});

function row(date: string, projectId: string, model: string, input: number) {
  return {
    date,
    projectId,
    provider: "p",
    model,
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    turns: 1,
    durationMs: MINUTE,
  };
}

function ask(session: SessionManager, at: number): void {
  vi.setSystemTime(at);
  session.appendMessage({
    role: "user",
    content: "Make it faster",
    timestamp: at,
  } as never);
}

function respond(
  session: SessionManager,
  {
    at,
    input,
    output,
    cacheRead = 0,
    provider = "anthropic",
    model = "claude-opus-5-5",
    api = "anthropic-messages",
  }: {
    at: number;
    input: number;
    output: number;
    cacheRead?: number;
    provider?: string;
    model?: string;
    api?: string;
  },
): string {
  vi.setSystemTime(at);
  return session.appendMessage({
    role: "assistant",
    api,
    provider,
    model,
    content: [{ type: "text", text: "Done" }],
    stopReason: "stop",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      totalTokens: input + output + cacheRead,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: at,
  } as never);
}

async function createProject(name = "Project"): Promise<ProjectState> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-usage-"));
  return {
    id: path.basename(directory),
    name,
    type: "web-game",
    updatedAt: new Date(0).toISOString(),
    workspacePath: path.join(directory, "workspace"),
    preview: { status: "waiting" },
  };
}
