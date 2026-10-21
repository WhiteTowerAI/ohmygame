import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { ArtifactBuilder } from "../src/daemon/publish/archive.js";
import {
  createNodeCodebase,
  readNodeCodebaseDetail,
  writeNodeCodebase,
} from "../src/daemon/playable-codebase.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
const state = vi.hoisted(() => ({
  child: undefined as ChildProcess | undefined,
  started: undefined as (() => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof realSpawn>) => {
      if (args[0] !== "publish-test-ffmpeg") return original.spawn(...args);
      state.child = original.spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        args[2],
      );
      state.started?.();
      return state.child;
    },
  };
});
it("terminates the active encoder when the builder closes", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "ohmygame-publish-close-"),
  );
  const builder = new ArtifactBuilder();
  vi.stubEnv("OHMYGAME_FFMPEG_PATH", "publish-test-ffmpeg");
  let publishing: Promise<Buffer> | undefined;
  try {
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    await mkdir(path.join(workspace, "assets"));
    await writeFile(
      path.join(workspace, "assets/video.mp4"),
      Buffer.alloc(512 * 1024),
    );
    const codebase = await readNodeCodebaseDetail(workspace);
    await writeNodeCodebase(workspace, {
      ...codebase,
      graph: {
        ...codebase.graph,
        nodes: codebase.graph.nodes.map((node) => ({ ...node, signals: [] })),
        assets: {
          video: {
            type: "video",
            source: { kind: "workspace", path: "assets/video.mp4" },
          },
        },
      },
    });
    const started = new Promise<void>((resolve) => {
      state.started = resolve;
    });
    publishing = builder.create({
      id: "publish-close",
      name: "Story",
      type: "interactive-story",
      workspacePath: workspace,
      updatedAt: new Date().toISOString(),
      preview: { status: "stopped" },
    });
    await started;
    await builder.close();
    await vi.waitFor(() =>
      expect(
        state.child!.exitCode !== null || state.child!.signalCode !== null,
      ).toBe(true),
    );
  } finally {
    state.child?.kill("SIGKILL");
    await publishing?.catch(() => {});
    vi.unstubAllEnvs();
    await rm(workspace, { recursive: true, force: true });
  }
});
