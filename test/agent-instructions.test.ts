import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentInstructionsStore, conversationInstructions } from "../src/daemon/agent-instructions.js";
import { appendSystemPromptForProject } from "../src/daemon/agent-prompts.js";
import { ensureOhMyGamePiEnvironment } from "../src/daemon/pi-agent.js";
import { createApp } from "../src/daemon/app.js";
import { USER_INSTRUCTIONS_MAX_CHARACTERS, type AgentInstructionsView, type ConversationInstructions } from "../src/shared/agent-instructions.js";
import type { ConversationSummary, ProjectState } from "../src/shared/contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function folder(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-instructions-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("the person's own agent instructions", () => {
  it("are saved trimmed, kept across restarts, and cleared when blank", async () => {
    const dataDirectory = await folder();
    const store = new AgentInstructionsStore(dataDirectory);
    expect(await store.get()).toBe("");

    expect(await store.set("  Reply in Chinese.\r\nKeep turns short.  ")).toBe("Reply in Chinese.\nKeep turns short.");
    expect(await new AgentInstructionsStore(dataDirectory).get()).toBe("Reply in Chinese.\nKeep turns short.");

    await store.set("   ");
    expect(await new AgentInstructionsStore(dataDirectory).get()).toBe("");
  });

  it("refuses instructions over the limit", async () => {
    const store = new AgentInstructionsStore(await folder());
    await expect(store.set("x".repeat(USER_INSTRUCTIONS_MAX_CHARACTERS + 1))).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.set("x".repeat(USER_INSTRUCTIONS_MAX_CHARACTERS))).resolves.toHaveLength(USER_INSTRUCTIONS_MAX_CHARACTERS);
  });

  it("leaves a file it can't read alone and uses no instructions from it", async () => {
    const dataDirectory = await folder();
    const file = path.join(dataDirectory, "agent-instructions.json");
    await writeFile(file, JSON.stringify({ version: 2, text: "From a newer app" }));
    const store = new AgentInstructionsStore(dataDirectory);

    expect(await store.get()).toBe("");
    expect(await store.problem()).toMatch(/isn't a file this version of OhMyGame can read/);
    await expect(store.set("Mine")).rejects.toMatchObject({ statusCode: 409 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 2, text: "From a newer app" });
  });

  it("come after OhMyGame's own instructions, in every kind of project", () => {
    for (const type of ["general", "web-game", "interactive-story", "asset-canvas", "plugin"] as const) {
      const own = appendSystemPromptForProject({ type });
      const withUser = appendSystemPromptForProject({ type, userInstructions: " Name every file in English. " });
      expect(withUser.slice(0, -1)).toEqual(own);
      expect(withUser.at(-1)).toMatch(/^The user's own instructions for every project follow\./);
      expect(withUser.at(-1)).toMatch(/current request, which takes precedence\.\n\nName every file in English\.$/);
      expect(appendSystemPromptForProject({ type, userInstructions: "  " })).toEqual(own);
    }
  });
});

describe("a conversation's instructions", () => {
  it("replay the system prompt and tools the model last received", () => {
    const tool = (name: string, description: string) => ({ name, description, parameters: { type: "object", properties: {} } });
    const instructions = conversationInstructions([
      {
        role: "system",
        content: "",
        sections: { preamble: "You are an expert coding assistant.", addendum: "<addendum>\nBuild browser games.\n</addendum>", cwd: "<cwd>\n/work\n</cwd>" },
        toolsAdded: [tool("read", "Read a file"), tool("bash", "Run a command")],
        timestamp: 1,
      },
      { role: "user", content: "Make a game", timestamp: 2 },
      // A later message changes one section, removes another and drops a tool.
      { role: "system", content: "", sections: { addendum: "<addendum>\nBuild browser games.\n\nReply in Chinese.\n</addendum>", cwd: null }, toolsRemoved: [{ name: "bash" }], timestamp: 3 },
    ] as never);

    expect(instructions).toEqual({
      kind: "ohmygame",
      started: true,
      sections: [
        { name: "preamble", text: "You are an expert coding assistant." },
        { name: "addendum", text: "Build browser games.\n\nReply in Chinese." },
      ],
      tools: [{ name: "read", description: "Read a file" }],
    });
  });

  it("are empty before the first message", () => {
    expect(conversationInstructions([])).toEqual({ kind: "ohmygame", started: false, sections: [], tools: [] });
  });
});

describe("agent instructions API", () => {
  async function start() {
    const dataDirectory = await folder();
    await ensureOhMyGamePiEnvironment(path.join(dataDirectory, "pi-agent"));
    const app = createApp({ dataDirectory, piAgentDirectory: path.join(dataDirectory, "pi-agent"), accessToken: "token" });
    cleanup.push(() => app.close());
    await app.ready();
    const call = async <T>(method: string, url: string, payload?: unknown) => {
      const response = await app.inject({ method: method as "GET", url, headers: { authorization: "Bearer token" }, ...(payload === undefined ? {} : { payload: payload as object }) });
      return { status: response.statusCode, body: (response.body ? response.json() : undefined) as T };
    };
    return { call, dataDirectory };
  }

  it("shows OhMyGame's instructions for each kind of project and saves the person's", async () => {
    const { call } = await start();
    const initial = (await call<AgentInstructionsView>("GET", "/settings/agent-instructions")).body;
    expect(initial.custom).toBe("");
    expect(initial.builtIn.map((entry) => entry.type)).toEqual(["web-game", "general", "interactive-story", "asset-canvas", "plugin"]);
    expect(initial.builtIn.find((entry) => entry.type === "web-game")?.text).toContain("OhMyGame owns the dev server");
    expect(initial.builtIn.find((entry) => entry.type === "general")?.text).toContain("Web preview is enabled by the user");

    const saved = await call<AgentInstructionsView>("PUT", "/settings/agent-instructions", { custom: " Reply in Chinese. " });
    expect(saved.status).toBe(200);
    expect(saved.body.custom).toBe("Reply in Chinese.");
    // Settings shows OhMyGame's own instructions; the person's are shown where they write them.
    expect(saved.body.builtIn.every((entry) => !entry.text.includes("Reply in Chinese."))).toBe(true);
    expect((await call<AgentInstructionsView>("GET", "/settings/agent-instructions")).body.custom).toBe("Reply in Chinese.");

    expect((await call("PUT", "/settings/agent-instructions", { custom: "x".repeat(USER_INSTRUCTIONS_MAX_CHARACTERS + 1) })).status).toBe(400);
    expect((await call("PUT", "/settings/agent-instructions", { custom: 3 })).status).toBe(400);
  });

  it("says why saved instructions can't be used and refuses to replace them", async () => {
    const { call, dataDirectory } = await start();
    await writeFile(path.join(dataDirectory, "agent-instructions.json"), "{");
    const view = (await call<AgentInstructionsView>("GET", "/settings/agent-instructions")).body;
    expect(view.custom).toBe("");
    expect(view.problem).toMatch(/agent-instructions\.json isn't a file/);
    const refused = await call<{ error: string }>("PUT", "/settings/agent-instructions", { custom: "Mine" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Fix or remove the file/);
  });

  it("shows a conversation's instructions", async () => {
    const { call } = await start();
    await call("PUT", "/settings/agent-instructions", { custom: "Reply in Chinese." });
    const project = (await call<ProjectState>("POST", "/projects", {})).body;
    const own = (await call<ConversationSummary>("POST", `/projects/${project.id}/conversations`, {})).body;
    expect((await call<ConversationInstructions>("GET", `/projects/${project.id}/conversations/${own.id}/instructions`)).body)
      .toEqual({ kind: "ohmygame", started: false, sections: [], tools: [] });

    expect((await call("GET", `/projects/${project.id}/conversations/missing/instructions`)).status).toBe(404);
    expect((await call("GET", `/projects/missing/conversations/${own.id}/instructions`)).status).toBe(404);
  });
});
