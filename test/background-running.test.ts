import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackgroundRunning } from "../src/desktop/background-running.js";

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "ohmygame-background-"));
  file = path.join(directory, "background-running.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("defaults off, persists the choice and restores the tray before enabling", async () => {
  const tray = { destroy: vi.fn() };
  const create = vi.fn(async () => tray);
  const preference = new BackgroundRunning(file, create);
  expect(await preference.initialize()).toBe(false);
  expect(create).not.toHaveBeenCalled();
  await preference.set(true);
  expect(preference.enabled).toBe(true);
  expect(create).toHaveBeenCalledOnce();
  await preference.set(true);
  expect(create).toHaveBeenCalledOnce();
  preference.dispose();
  expect(tray.destroy).toHaveBeenCalledOnce();
  const restored = new BackgroundRunning(file, create);
  expect(restored.enabled).toBe(false);
  expect(await restored.initialize()).toBe(true);
  expect(create).toHaveBeenCalledTimes(2);
  await restored.set(false);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    version: 1,
    enabled: false,
  });
  expect(tray.destroy).toHaveBeenCalledTimes(2);
});

it.each(["{", '{"version":2,"enabled":true}', '{"version":1,"enabled":"yes"}'])(
  "does not overwrite unreadable data: %s",
  async (stored) => {
    await writeFile(file, stored);
    const preference = new BackgroundRunning(file);
    await expect(preference.initialize()).rejects.toThrow();
    await expect(preference.set(true)).rejects.toThrow();
    expect(preference.enabled).toBe(false);
    expect(await readFile(file, "utf8")).toBe(stored);
  },
);

it("retains unknown fields and the previous setting on a failed write", async () => {
  await writeFile(
    file,
    JSON.stringify({ version: 1, enabled: false, future: { keep: 1 } }),
  );
  const preference = new BackgroundRunning(file);
  await preference.set(true);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    future: { keep: 1 },
  });
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  await expect(preference.set(false)).rejects.toThrow();
  expect(preference.enabled).toBe(true);
});

it("keeps ordinary close available if tray creation fails, then permits retry", async () => {
  const create = vi.fn(async () => ({ destroy: vi.fn() }));
  create.mockRejectedValueOnce(new Error("No tray"));
  const preference = new BackgroundRunning(file, create);
  await expect(preference.set(true)).rejects.toThrow("No tray");
  expect(preference.enabled).toBe(false);
  expect(await preference.set(true)).toBe(true);
});

it("serializes changes and destroys a tray that finishes starting after Quit", async () => {
  let finish!: (tray: { destroy(): void }) => void;
  const tray = { destroy: vi.fn() };
  const create = () =>
    new Promise<{ destroy(): void }>((resolve) => {
      finish = resolve;
    });
  const preference = new BackgroundRunning(file, create);
  const enabled = preference.set(true);
  const disabled = preference.set(false);
  await Promise.resolve();
  finish(tray);
  await enabled;
  await disabled;
  expect(preference.enabled).toBe(false);
  expect(tray.destroy).toHaveBeenCalledOnce();

  const late = preference.set(true);
  await Promise.resolve();
  await Promise.resolve();
  preference.dispose();
  finish(tray);
  await expect(late).rejects.toThrow("quitting");
  expect(tray.destroy).toHaveBeenCalledTimes(2);
  expect(preference.enabled).toBe(false);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    enabled: false,
  });
});
