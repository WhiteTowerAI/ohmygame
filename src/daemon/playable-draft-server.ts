import { rm } from "node:fs/promises";
import type { ProjectState } from "../shared/contracts.js";
import { LoopbackFileServer } from "./loopback-file-server.js";

/** Drafts kept at once; the oldest is removed when an agent opens another. */
const MAX_DRAFTS = 4;

/**
 * Serves Playable drafts to agent playtests. Each draft is a Published Player
 * build of the project's current sources, served on loopback under an
 * unguessable path.
 */
export class PlayableDraftServer {
  readonly #files = new LoopbackFileServer();
  readonly #drafts: Array<{ token: string; directory: string }> = [];

  constructor(private readonly prepare: (project: ProjectState) => Promise<string>) {}

  /** Builds the project's draft and returns the URL of its Player. */
  async open(project: ProjectState): Promise<string> {
    const directory = await this.prepare(project);
    const { token, url } = await this.#files.mount(directory);
    this.#drafts.push({ token, directory });
    for (const old of this.#drafts.splice(0, Math.max(0, this.#drafts.length - MAX_DRAFTS))) {
      this.#files.unmount(old.token);
      await rm(old.directory, { recursive: true, force: true });
    }
    return `${url}index.html`;
  }

  async close(): Promise<void> {
    const directories = this.#drafts.splice(0).map(({ directory }) => directory);
    await this.#files.close();
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }
}
