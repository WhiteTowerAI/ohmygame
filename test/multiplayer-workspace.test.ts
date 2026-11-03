import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { installMultiplayerWorkspace, moveWorkspaceMultiplayer, readWorkspaceMultiplayer } from "../src/daemon/multiplayer-workspace.js";
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
      // A game with no package dependencies can bundle the SDK.
      await expect(
        build({
          entryPoints: [path.join(directory, "src/ohmygame/client.js")],
          bundle: true,
          write: false,
          platform: "browser",
        }),
      ).resolves.toHaveProperty("outputFiles");
      const declaration = await readFile(
        path.join(directory, "src/ohmygame/multiplayer-client.d.ts"),
        "utf8",
      );
      expect(declaration).not.toContain("@colyseus/sdk");
      // The public API report: a change to what games can call shows up in review.
      const names = ["client", "index", "errors", "identity", "define-game", "multiplayer-client", "multiplayer-protocol", "gomoku"];
      const report = await Promise.all(names.map(async (name) =>
        `// ${name}.d.ts\n${await readFile(path.join(directory, `src/ohmygame/${name}.d.ts`), "utf8")}`));
      await expect(report.join("\n")).toMatchFileSnapshot("../packages/sdk/api/ohmygame-sdk.api.d.ts");
      // Rules files import defineGame from a copy with no dependencies.
      const { defineGame } = await import(pathToFileURL(path.join(directory, "src/ohmygame/define-game.js")).href);
      const rules = { players: { min: 2, max: 2 }, setup: () => ({}), moves: {} };
      expect(defineGame(rules)).toBe(rules);
      // Test-only injection points stay out of the copied declarations, and the bundle names its version.
      expect(declaration).not.toContain("transport");
      expect(
        await readFile(path.join(directory, "src/ohmygame/client.js"), "utf8"),
      ).toMatch(/^\/\* @ohmygame\/sdk \d+\.\d+\.\d+ \*\//);
      expect(
        await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8"),
      ).toContain("16 hexadecimal");
      // Local publishing plays the production build, so the guide never gates localhost on a dev flag.
      expect(
        await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8"),
      ).toContain("never import.meta.env.DEV");

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
});
