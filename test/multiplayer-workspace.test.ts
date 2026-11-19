import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { installGameSdk, installMultiplayerWorkspace, moveLocalGameServices, moveWorkspaceMultiplayer, readWorkspaceMultiplayer, runWorkspaceRulesTests } from "../src/daemon/multiplayer-workspace.js";
import type { MultiplayerManifestConfig } from "@ohmygame/game-sdk/protocol";

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
      const names = ["client", "multiplayer", "index", "errors", "identity", "account", "account-protocol", "cloud", "cloud-protocol", "define-game", "host", "multiplayer-client", "multiplayer-protocol", "peers", "rules", "smoothing", "testing"];
      const report = await Promise.all(names.map(async (name) =>
        `// ${name}.d.ts\n${await readFile(path.join(directory, `src/ohmygame/${name}.d.ts`), "utf8")}`));
      await expect(report.join("\n")).toMatchFileSnapshot("../packages/game-sdk/api/ohmygame-sdk.api.d.ts");
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
        ).toMatch(/^\/\* @ohmygame\/game-sdk \d+\.\d+\.\d+ \*\//);
      expect(
        await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8"),
      ).toContain("16 hexadecimal");
      // Local publishing plays the production build, so the guide never gates localhost on a dev flag.
      expect(
        await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8"),
      ).toContain("never import.meta.env.DEV");
      // Owner games learn the SDK's own direct connections, not a WebRTC stack of their own.
      const projectGuide = await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8");
      expect(projectGuide).toContain("createMultiplayerClient(game, callbacks, { p2p: true })");
      // The guide written into a project and the SDK's agent guide teach the same client
      // features: the desktop agent reads only the first, other coding agents the second.
      const sdkGuide = await readFile(path.join(process.cwd(), "packages/game-sdk/AGENT_GUIDE.md"), "utf8");
      // Both say which deployments take p2p, with the error the SDK throws for the others.
      for (const guide of [projectGuide, sdkGuide]) expect(guide).toContain("p2p is for owner deployments");
      for (const feature of ["Smoother", "client.tickMs", "p2p", "client.peers", "setState", "updateShared", "emit(", "signOut", "onAuthChange", "onMessage", "rate_limited", "finishRound", "quickPlay", "sendInput", "sendAction", "onHost", "reconnect()", "inviteCode"]) {
        expect(projectGuide, `project guide mentions ${feature}`).toContain(feature);
        expect(sdkGuide, `AGENT_GUIDE.md mentions ${feature}`).toContain(feature);
      }

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
      // Rules tests are for multiplayer games.
      await expect(readFile(path.join(directory, "src/ohmygame/testing.js"), "utf8")).rejects.toThrow();
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

  it("runs a game's tests of its own rules with the SDK copy setup wrote", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-rules-tests-"));
    const config: MultiplayerManifestConfig = {
      enabled: true, mode: "turn-based", adapterId: "host", gameId: "count", deploymentId: "local-host-v1", protocolVersion: 1,
      serverUrl: "http://127.0.0.1:43130", authPolicy: "anonymous", roomPolicy: "invite-or-public", maxClients: 2, reconnectSeconds: 120,
    };
    try {
      const project = { workspacePath: directory };
      await expect(runWorkspaceRulesTests(project)).rejects.toThrow("Write server/rules.test.ts first");
      await installMultiplayerWorkspace(project, config);
      expect(await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8")).toContain("multiplayer_rules_test");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(directory, "server"), { recursive: true }));
      await writeFile(path.join(directory, "server/rules.ts"), `import { defineGame } from "../src/ohmygame/define-game.js";
export default defineGame({
  players: { min: 2, max: 2 },
  setup: (ctx) => ({ count: 0, order: ctx.shuffle([1, 2, 3, 4]) }),
  moves: { add: (G, _ctx, { by }) => { if (by < 1) throw new Error("Add at least 1."); G.count += by; } },
  endIf: (G) => (G.count >= 3 ? { winners: ["a"] } : undefined),
});
`);
      await writeFile(path.join(directory, "server/rules.test.ts"), `import assert from "node:assert/strict";
import { test, simulateRoom } from "../src/ohmygame/testing.js";
import rules from "./rules";

test("adds on each turn", () => {
  const room = simulateRoom(rules, { players: ["a", "b"] }).start();
  room.move("a", "add", { by: 1 });
  assert.equal(room.game.count, 1);
  assert.throws(() => room.move("a", "add", { by: 1 }), /another player's turn/);
});
test("the same seed shuffles the same", () => {
  const order = (seed: number) => simulateRoom(rules, { players: ["a", "b"], seed }).start().game.order;
  assert.deepEqual(order(3), order(3));
});
test("refuses adding nothing", async () => {
  const room = simulateRoom(rules, { players: ["a", "b"] }).start();
  room.move("a", "add", { by: 0 });
});
test("ends at three", () => {
  const room = simulateRoom(rules, { players: ["a", "b"] }).start();
  room.move("a", "add", { by: 3 });
  assert.equal(room.phase, "finished");
});
`);
      const run = await runWorkspaceRulesTests(project);
      expect(run).toMatchObject({ passed: 3, failed: 1 });
      expect(run.text).toContain("server/rules.test.ts: 3 passed, 1 failed.");
      expect(run.text).toContain("FAILED - refuses adding nothing: Add at least 1.");
      expect(run.text).toContain("ok - ends at three");

      // A test that never ends is cut off, and says which one.
      await writeFile(path.join(directory, "server/hang.test.ts"), `import { test } from "../src/ohmygame/testing.js";
test("first", () => {});
test("forever", () => { while (true) {} });
test("never runs", () => {});
`);
      const { runGameRulesTests } = await import("@ohmygame/server");
      const hung = await runGameRulesTests(path.join(directory, "server/hang.test.ts"), 1_000);
      expect(hung).toEqual({ timedOut: "forever", results: [{ name: "first", ok: true, ms: expect.any(Number) }] });
      await writeFile(path.join(directory, "server/broken.test.ts"), `import { nothing } from "./missing";\nconsole.log(nothing);\n`);
      await expect(runWorkspaceRulesTests(project, "server/broken.test.ts")).rejects.toThrow("The test file did not build");
      await expect(runWorkspaceRulesTests(project, "../outside.test.ts")).rejects.toThrow("inside the game's folder");
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
