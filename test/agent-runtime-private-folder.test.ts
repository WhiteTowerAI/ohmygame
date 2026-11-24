import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Windows reports EBUSY while a CLI that ran in the folder is still exiting.
// This file mocks rm, so it is kept apart from the discovery tests.
const busy = vi.hoisted(() => ({ folders: new Set<string>() }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rm: async (target: string, options?: Parameters<typeof fs.rm>[1]) => {
      if (busy.folders.has(target))
        throw Object.assign(
          new Error(`EBUSY: resource busy or locked, rmdir '${target}'`),
          { code: "EBUSY" },
        );
      return fs.rm(target, options);
    },
  };
});

const { privateFolder } =
  await import("../src/daemon/agent-runtimes/discovery.js");

const roots: string[] = [];
afterEach(async () => {
  busy.folders.clear();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("does not fail a finished probe when its folder is still busy", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ohmygame-private-folder-"),
  );
  roots.push(root);
  const folder = await privateFolder(root, "claude-code-cli");
  busy.folders.add(folder.path);
  await expect(folder.remove()).resolves.toBeUndefined();
});
