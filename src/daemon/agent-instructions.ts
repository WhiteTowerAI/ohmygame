import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentText, getCurrentSystemMessage, getCurrentTools, type TranscriptMessages } from "@earendil-works/pi-ai";
import { USER_INSTRUCTIONS_MAX_CHARACTERS, type ConversationInstructions } from "../shared/agent-instructions.js";

// The person's own instructions for the agent in every project, kept in
// `agent-instructions.json` in the app's data folder. A file this version
// can't read is left as it is: the instructions stay off and changing them
// is refused until it's fixed or removed.

interface Stored {
  version: 1;
  text: string;
}

export class AgentInstructionsError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export class AgentInstructionsStore {
  readonly #file: string | undefined;
  #text = "";
  #problem: string | undefined;
  #loading: Promise<void> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  /** Without a data directory, the instructions last until the app closes. */
  constructor(dataDirectory?: string) {
    this.#file = dataDirectory ? path.join(dataDirectory, "agent-instructions.json") : undefined;
  }

  /** The instructions, empty when there are none or the file can't be read. */
  async get(): Promise<string> {
    await this.#load();
    return this.#problem ? "" : this.#text;
  }

  /** Why the saved instructions can't be used, when they can't. */
  async problem(): Promise<string | undefined> {
    await this.#load();
    return this.#problem;
  }

  /** Saves new instructions; blank ones clear them. */
  set(text: string): Promise<string> {
    const run = this.#queue.then(async () => {
      await this.#load();
      if (this.#problem) throw new AgentInstructionsError(`${this.#problem} Fix or remove the file to change your instructions.`, 409);
      const next = text.replace(/\r\n?/g, "\n").trim();
      if (next.length > USER_INSTRUCTIONS_MAX_CHARACTERS) throw new AgentInstructionsError(`Instructions can be at most ${USER_INSTRUCTIONS_MAX_CHARACTERS} characters.`);
      if (this.#file) {
        await mkdir(path.dirname(this.#file), { recursive: true });
        const temporary = `${this.#file}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ version: 1, text: next } satisfies Stored, null, 2)}\n`);
        await rename(temporary, this.#file);
      }
      this.#text = next;
      return next;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  #load(): Promise<void> {
    this.#loading ??= (async () => {
      if (!this.#file) return;
      let text: string;
      try {
        text = await readFile(this.#file, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") this.#problem = `${this.#file} can't be read.`;
        return;
      }
      const stored = parseStored(text);
      if (stored) this.#text = stored.text;
      else this.#problem = `${this.#file} isn't a file this version of OhMyGame can read.`;
    })();
    return this.#loading;
  }
}

function parseStored(text: string): Stored | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const { version, text: instructions } = value as Partial<Stored>;
    return version === 1 && typeof instructions === "string" ? { version, text: instructions } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What OhMyGame's agent was last told in a conversation: the system prompt
 * and tools its transcript replays to, as the model received them.
 */
export function conversationInstructions(messages: TranscriptMessages): Extract<ConversationInstructions, { kind: "ohmygame" }> {
  const system = getCurrentSystemMessage(messages);
  if (!system) return { kind: "ohmygame", started: false, sections: [], tools: [] };
  const sections: Array<{ name: string; text: string }> = [];
  const base = contentText(system.content).trim();
  if (base) sections.push({ name: "base", text: base });
  for (const [name, text] of Object.entries(system.sections ?? {})) {
    if (text) sections.push({ name, text: unwrapSection(name, text) });
  }
  const tools = getCurrentTools(messages).map((tool) => ({ name: tool.name, description: tool.description }));
  return { kind: "ohmygame", started: true, sections, tools };
}

/** A section as written, without the tags that mark it for the model. */
function unwrapSection(name: string, text: string): string {
  const open = `<${name}>\n`;
  const close = `\n</${name}>`;
  return text.startsWith(open) && text.endsWith(close) ? text.slice(open.length, -close.length) : text;
}
