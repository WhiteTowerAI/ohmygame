import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { installGameSdk, installMultiplayerWorkspace, moveLocalGameServices, moveWorkspaceMultiplayer, readWorkspaceMultiplayer } from "../src/daemon/multiplayer-workspace.js";
import type { MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";

describe("multiplayer workspace integration", () => {
  it("writes a self-contained SDK and preserves unrelated game manifest fields", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-multiplayer-workspace-"),
    );
    const config: MultiplayerManifestConfig = {
      enabled: true,
      mode: "turn-based",
      adapterId: "gomoku",
      gameId: "board",
      deploymentId: "local-v1",
      protocolVersion: 1,
      serverUrl: "http://127.0.0.1:43130",
      authPolicy: "anonymous",
      roomPolicy: "invite-or-public",
      maxClients: 2,
      reconnectSeconds: 120,
    };
    try {
      const project = { workspacePath: directory };
      await installMultiplayerWorkspace(project, config);
      await writeFile(
        path.join(directory, "public/manifest.json"),
        JSON.stringify({ title: "Board", multiplayer: config }),
      );
      await installMultiplayerWorkspace(project, config);
      expect(
        JSON.parse(
          await readFile(path.join(directory, "public/manifest.json"), "utf8"),
        ),
      ).toEqual({ version: 1, title: "Board", multiplayer: config });
      expect(
        JSON.parse(
          await readFile(path.join(directory, "multiplayer.json"), "utf8"),
        ).multiplayer,
      ).toEqual(config);
      // A game with no package dependencies can bundle the SDK, and only a game that imports
      // multiplayer.js carries the room client.
      const bundle = async (code: string) => {
        const entry = path.join(directory, "src", `entry-${Math.random().toString(36).slice(2)}.js`);
        await writeFile(entry, code);
        const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "browser", format: "esm" });
        return result.outputFiles[0]!.text;
      };
      const solo = await bundle(`import { init } from "./ohmygame/client.js"; init().then(console.log);`);
      const rooms = await bundle(
        `import { init } from "./ohmygame/client.js"; import { createMultiplayerClient } from "./ohmygame/multiplayer.js";
        init().then((game) => createMultiplayerClient(game));`,
      );
      expect(solo).not.toContain("joinOrCreate");
      expect(rooms).toContain("joinOrCreate");
      expect(solo.length * 5).toBeLessThan(rooms.length);
      // Both files share one OhMyGameError, so instanceof holds for errors from either.
      expect(rooms.match(/OhMyGameError = class/g)).toHaveLength(1);
      const declaration = await readFile(
        path.join(directory, "src/ohmygame/multiplayer-client.d.ts"),
        "utf8",
      );
      expect(declaration).not.toContain("@colyseus/sdk");
      // The public API report: a change to what games can call shows up in review.
      const names = ["client", "multiplayer", "index", "errors", "identity", "account", "account-protocol", "cloud", "cloud-protocol", "define-game", "host", "multiplayer-client", "multiplayer-protocol", "peers", "rules", "smoothing"];
      const report = await Promise.all(names.map(async (name) =>
        `// ${name}.d.ts\n${await readFile(path.join(directory, `src/ohmygame/${name}.d.ts`), "utf8")}`));
      await expect(report.join("\n")).toMatchFileSnapshot("../packages/sdk/api/ohmygame-sdk.api.d.ts");
      // Rules files import defineGame from a copy with no dependencies.
      const { defineGame } = await import(pathToFileURL(path.join(directory, "src/ohmygame/define-game.js")).href);
      const rules = { players: { min: 2, max: 2 }, setup: () => ({}), moves: {} };
      expect(defineGame(rules)).toBe(rules);
      // Test-only injection points stay out of the copied declarations, and the bundle names its version.
      expect(declaration).not.toContain("transport");
      // The built-in rules' helpers are not SDK API: setup writes them beside it for the games that play those rules.
      const gomoku = await import(pathToFileURL(path.join(directory, "src/ohmygame/gomoku.js")).href);
      expect(gomoku.isGomokuState(gomoku.initialGomokuState())).toBe(true);
      expect(await readFile(path.join(directory, "src/ohmygame/gomoku.d.ts"), "utf8")).toContain("isGomokuState");
      expect(await readFile(path.join(directory, "src/ohmygame/client.d.ts"), "utf8")).not.toContain("gomoku");
      for (const name of ["client.js", "multiplayer.js"])
        expect(
          await readFile(path.join(directory, "src/ohmygame", name), "utf8"),
        ).toMatch(/^\/\* @ohmygame\/sdk \d+\.\d+\.\d+ \*\//);
      expect(
        await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8"),
      ).toContain("16 hexadecimal");
      // Local publishing plays the production build, so the guide never gates localhost on a dev flag.
      expect(
        await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8"),
      ).toContain("never import.meta.env.DEV");
      // Owner games learn the SDK's own direct connections, not a WebRTC stack of their own.
      expect(
        await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8"),
      ).toContain("createMultiplayerClient(game, callbacks, { p2p: true })");

      // After a restart the local service may listen elsewhere; only files still declaring the old address move.
      expect(await readWorkspaceMultiplayer(project)).toEqual(config);
      const moved = { ...config, serverUrl: "http://127.0.0.1:43139" };
      const edited = { ...config, deploymentId: "local-v2" };
      await writeFile(path.join(directory, "multiplayer.json"), JSON.stringify({ multiplayer: edited }));
      await moveWorkspaceMultiplayer(project, config, moved);
      expect(await readWorkspaceMultiplayer(project)).toEqual(edited);
      expect(
        JSON.parse(
          await readFile(path.join(directory, "public/manifest.json"), "utf8"),
        ),
      ).toEqual({ version: 1, title: "Board", multiplayer: moved });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sets up the SDK for saves and leaderboards in a single-player game, and keeps a multiplayer setup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-game-sdk-"));
    try {
      const project = { workspacePath: directory };
      const result = await installGameSdk(project);
      expect(result).toEqual({ sdkPath: "src/ohmygame", manifestPath: "public/manifest.json", guidePath: "src/ohmygame/README.md" });
      expect(JSON.parse(await readFile(path.join(directory, "public/manifest.json"), "utf8"))).toEqual({ version: 1 });
      const guide = await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8");
      expect(guide).toContain("game.storage");
      expect(guide).toContain("game.leaderboard");
      expect(guide).not.toContain("Colyseus");
      await writeFile(path.join(directory, "public/manifest.json"), JSON.stringify({ title: "Puzzle" }));
      await installGameSdk(project);
      expect(JSON.parse(await readFile(path.join(directory, "public/manifest.json"), "utf8"))).toEqual({ version: 1, title: "Puzzle" });

      // A game that already plays multiplayer keeps its deployment and its guide.
      const config: MultiplayerManifestConfig = {
        enabled: true, mode: "turn-based", adapterId: "stones", gameId: "puzzle", deploymentId: "local-v1", protocolVersion: 1,
        serverUrl: "http://127.0.0.1:43130", authPolicy: "anonymous", roomPolicy: "invite-or-public", maxClients: 2, reconnectSeconds: 120,
      };
      await installMultiplayerWorkspace(project, config);
      await installGameSdk(project);
      expect(JSON.parse(await readFile(path.join(directory, "public/manifest.json"), "utf8")).multiplayer).toEqual(config);
      const both = await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8");
      expect(both).toContain("Colyseus");
      expect(both).toContain("game.storage");

      await writeFile(path.join(directory, "public/manifest.json"), JSON.stringify({ runtime: "playable-nodes" }));
      await expect(installGameSdk(project)).rejects.toThrow("supported Web Game manifest");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("points a game at the local service's sign-in, saves and leaderboards, and follows it to a new address", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-local-services-"));
    const services = (port: number) => ({
      account: { issuer: `http://127.0.0.1:${port}` },
      cloud: { serverUrl: `http://127.0.0.1:${port}/`, gameId: "project-1" },
    });
    const manifest = async () => JSON.parse(await readFile(path.join(directory, "public/manifest.json"), "utf8"));
    try {
      const project = { workspacePath: directory };
      await installGameSdk(project, services(43139));
      expect(await manifest()).toEqual({ version: 1, ...services(43139) });
      expect(await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8")).toContain("init({ allowLocalhost: true })");

      // After a restart on another port, the local entries move; nothing else does.
      let asked = 0;
      await moveLocalGameServices(project, async () => (asked++, services(50000)));
      expect(await manifest()).toEqual({ version: 1, ...services(50000) });
      await writeFile(path.join(directory, "public/manifest.json"), JSON.stringify({ title: "Solo" }));
      await moveLocalGameServices(project, async () => (asked++, services(50001)));
      expect(asked).toBe(1);
      expect(await manifest()).toEqual({ title: "Solo" });

      // A game that names services off this computer keeps them.
      const own = { account: { issuer: "https://accounts.example" }, cloud: { serverUrl: "https://games.example/", gameId: "g" } };
      await writeFile(path.join(directory, "public/manifest.json"), JSON.stringify(own));
      await installGameSdk(project, services(43139));
      expect(await manifest()).toEqual({ version: 1, ...own });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
