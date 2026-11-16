import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GpuCrashCounter, readGpuFallback, setGpuFallback } from "../src/desktop/gpu-fallback.js";

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "ohmygame-gpu-fallback-"));
  file = path.join(directory, "gpu-fallback.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("reads no fallback when the flag is missing or unusable", async () => {
  expect(readGpuFallback(file)).toBe(false);
  await writeFile(file, "not json");
  expect(readGpuFallback(file)).toBe(false);
  await writeFile(file, JSON.stringify({ version: 2, disabled: true }));
  expect(readGpuFallback(file)).toBe(false);
});

it("writes and clears the flag for the setting", async () => {
  setGpuFallback(file, true);
  expect(readGpuFallback(file)).toBe(true);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, disabled: true });
  setGpuFallback(file, false);
  expect(existsSync(file)).toBe(false);
  expect(readGpuFallback(file)).toBe(false);
});

it("falls back only after repeated crashes within the window", () => {
  let now = 1_000;
  const crashes = new GpuCrashCounter(file, 3, 60_000, () => now);
  expect(crashes.recordGpuCrash()).toBe(false);
  expect(crashes.recordGpuCrash()).toBe(false);
  expect(readGpuFallback(file)).toBe(false);
  now += 1_000;
  expect(crashes.recordGpuCrash()).toBe(true);
  expect(readGpuFallback(file)).toBe(true);
});

it("counts crashes further apart as separate failures", () => {
  let now = 1_000;
  const crashes = new GpuCrashCounter(file, 3, 60_000, () => now);
  crashes.recordGpuCrash();
  crashes.recordGpuCrash();
  now += 61_000;
  expect(crashes.recordGpuCrash()).toBe(false);
  expect(readGpuFallback(file)).toBe(false);
});

it("keeps saying the fallback is needed once the flag is written", () => {
  let now = 1_000;
  const crashes = new GpuCrashCounter(file, 3, 60_000, () => now);
  for (let i = 0; i < 3; i += 1) expect(crashes.recordGpuCrash()).toBe(i === 2);
  expect(crashes.recordGpuCrash()).toBe(true);
  expect(readGpuFallback(file)).toBe(true);
});

it("does not request another fallback after restarting with software rendering", () => {
  const hardwareLaunch = new GpuCrashCounter(file);
  for (let i = 0; i < 3; i += 1) hardwareLaunch.recordGpuCrash();
  expect(readGpuFallback(file)).toBe(true);

  const softwareLaunch = new GpuCrashCounter(file);
  for (let i = 0; i < 6; i += 1) expect(softwareLaunch.recordGpuCrash()).toBe(false);
  expect(readGpuFallback(file)).toBe(true);
  // Turning acceleration back on only affects the next launch.
  setGpuFallback(file, false);
  for (let i = 0; i < 6; i += 1) expect(softwareLaunch.recordGpuCrash()).toBe(false);
  expect(readGpuFallback(file)).toBe(false);

  const retryHardwareLaunch = new GpuCrashCounter(file);
  expect(retryHardwareLaunch.recordGpuCrash()).toBe(false);
  expect(retryHardwareLaunch.recordGpuCrash()).toBe(false);
  expect(retryHardwareLaunch.recordGpuCrash()).toBe(true);
});
