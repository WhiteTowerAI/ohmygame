import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { installMultiplayerWorkspace } from "../src/daemon/multiplayer-workspace.js";
import type { MultiplayerManifestConfig } from "../src/shared/multiplayer-protocol.js";

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
      expect(
        await readFile(path.join(directory, "src/ohmygame/README.md"), "utf8"),
      ).toContain("16 hexadecimal");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
