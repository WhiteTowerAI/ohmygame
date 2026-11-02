import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScheduledMessage } from "../shared/contracts.js";

/** The longest a message waits between looks, which is also how often one that is due tries again. */
const CHECK_MS = 30_000;

/** Runs straight after the lookup, and returns false or throws for the message to wait. */
export type ScheduledSend = () => boolean;

interface Stored extends ScheduledMessage {
  projectId: string;
  conversationId: string;
}

/**
 * Messages the person asked to send later. They are saved, so they survive a restart. One that came
 * due with OhMyGame closed is held as missed for the person to decide on, and never sent on startup,
 * which also keeps a message sent just before a crash from going twice.
 */
export class ScheduledMessages {
  readonly #file: string;
  readonly #messages = new Map<string, Stored>();
  #timer?: ReturnType<typeof setTimeout>;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    dataDirectory: string,
    /** Undefined when the conversation no longer exists. */
    private readonly lookup: (projectId: string, conversationId: string, prompt: string) => Promise<ScheduledSend | undefined>,
    private readonly onChange: (projectId: string, conversationId: string, messages: ScheduledMessage[]) => void,
  ) {
    this.#file = path.join(dataDirectory, "scheduled-messages.json");
  }

  async load(): Promise<void> {
    let saved: string;
    try {
      saved = await readFile(this.#file, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    const now = Date.now();
    const { messages } = JSON.parse(saved) as { messages: Stored[] };
    for (const message of messages.map((item) => ({ ...item, ...(item.at <= now ? { missed: true } : {}) }))) this.#messages.set(message.id, message);
    this.#arm();
  }

  list(projectId: string, conversationId: string): ScheduledMessage[] {
    return [...this.#messages.values()]
      .filter((message) => message.projectId === projectId && message.conversationId === conversationId)
      .sort((a, b) => a.at - b.at)
      .map(({ id, prompt, at, missed }) => ({ id, prompt, at, ...(missed ? { missed } : {}) }));
  }

  add(projectId: string, conversationId: string, prompt: string, at: number): void {
    const message: Stored = { id: randomUUID(), projectId, conversationId, prompt, at };
    this.#messages.set(message.id, message);
    this.#changed(message);
  }

  remove(projectId: string, conversationId: string, id: string): boolean {
    const message = this.#messages.get(id);
    if (message?.projectId !== projectId || message.conversationId !== conversationId) return false;
    this.#messages.delete(id);
    this.#changed(message);
    return true;
  }

  /** Waits for what is being saved. A look still in progress finds its message gone and sends nothing. */
  async close(): Promise<void> {
    clearTimeout(this.#timer);
    this.#messages.clear();
    await this.#writes;
  }

  #arm(): void {
    clearTimeout(this.#timer);
    const now = Date.now();
    const waiting = [...this.#messages.values()].filter((message) => !message.missed);
    if (!waiting.length) return;
    const untilNext = waiting.map((message) => message.at - now).filter((delay) => delay > 0);
    this.#timer = setTimeout(() => void this.#check(), Math.min(CHECK_MS, ...untilNext));
  }

  async #check(): Promise<void> {
    const now = Date.now();
    const due = [...this.#messages.values()].filter((message) => !message.missed && message.at <= now).sort((a, b) => a.at - b.at);
    for (const message of due) {
      try {
        const send = await this.lookup(message.projectId, message.conversationId, message.prompt);
        // Asked straight after the lookup, with nothing awaited in between, so a message removed meanwhile stays unsent.
        if (this.#messages.get(message.id) !== message || (send && !send())) continue;
        this.#messages.delete(message.id);
        this.#changed(message);
      } catch (cause) {
        console.warn("Could not send a scheduled message yet", cause);
      }
    }
    this.#arm();
  }

  #changed(message: Stored): void {
    this.#save();
    this.onChange(message.projectId, message.conversationId, this.list(message.projectId, message.conversationId));
    this.#arm();
  }

  #save(): void {
    const messages = [...this.#messages.values()].map(({ id, projectId, conversationId, prompt, at }) => ({ id, projectId, conversationId, prompt, at }));
    this.#writes = this.#writes.then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ messages }, null, 2)}\n`);
        await rename(temporary, this.#file);
      } catch (cause) {
        await rm(temporary, { force: true });
        throw cause;
      }
    }).catch((cause) => console.warn("Could not save scheduled messages", cause));
  }
}
