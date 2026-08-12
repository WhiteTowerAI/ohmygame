import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommunityGame, Deployment, ProjectState } from "../shared/contracts.js";
import { playUrlFor } from "./deployments.js";

interface StoredCommunityGame {
  id: string;
  projectId: string;
  title: string;
  deploymentId: string;
  publishedAt: string;
}

export class CommunityStore {
  readonly #games = new Map<string, CommunityGame>();
  readonly #gamesDirectory: string;

  constructor(
    dataDirectory: string,
    private readonly playOrigin: string,
  ) {
    this.#gamesDirectory = path.join(dataDirectory, "community", "games");
  }

  async load(): Promise<void> {
    await mkdir(this.#gamesDirectory, { recursive: true });
    for (const entry of await readdir(this.#gamesDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const stored = JSON.parse(await readFile(path.join(this.#gamesDirectory, entry.name), "utf8")) as StoredCommunityGame;
      if (validGame(stored)) this.#games.set(stored.id, hydrate(stored, this.playOrigin));
    }
  }

  list(): CommunityGame[] {
    return [...this.#games.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }

  async publish(project: ProjectState, deployment: Deployment): Promise<CommunityGame> {
    const game: CommunityGame = {
      id: project.id,
      projectId: project.id,
      title: project.name,
      deploymentId: deployment.id,
      playUrl: deployment.playUrl,
      publishedAt: deployment.createdAt,
    };
    const destination = path.join(this.#gamesDirectory, `${game.id}.json`);
    const temporary = `${destination}.${process.pid}.tmp`;
    const { playUrl: _, ...stored } = game;
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
    this.#games.set(game.id, game);
    return game;
  }
}

function hydrate(game: StoredCommunityGame, playOrigin: string): CommunityGame {
  return { ...game, playUrl: playUrlFor(playOrigin, game.deploymentId) };
}

function validGame(value: StoredCommunityGame): boolean {
  return Boolean(
    value && typeof value.id === "string" && typeof value.projectId === "string" &&
    typeof value.title === "string" && typeof value.deploymentId === "string" &&
    typeof value.publishedAt === "string",
  );
}
