import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { validatePluginManifest } from "../src/shared/plugin-manifest.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("packages a valid PixelLab plugin and uses the character animation API without local pose data", async () => {
  const manifest = JSON.parse(await readFile("plugins/pixellab/.ohmygame-plugin/plugin.json", "utf8"));
  expect(validatePluginManifest(manifest).ok).toBe(true);
  expect(manifest.appliesTo).toBeUndefined();

  const commands = new Map<string, (input: unknown, call: unknown) => Promise<unknown>>();
  const plugin = await import(pathToFileURL(path.resolve("plugins/pixellab/native/index.mjs")).href);
  plugin.activate({ registerCommand: (name: string, handler: (input: unknown, call: unknown) => Promise<unknown>) => { commands.set(name, handler); } });
  const output = await mkdtemp(path.join(tmpdir(), "ohmygame-pixellab-plugin-"));
  directories.push(output);
  await writeFile(path.join(output, "source.png"), "source");
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/create-character-v3")) return Response.json({ character_id: "character", background_job_id: "character-job" });
    if (url.endsWith("/background-jobs/character-job") || url.endsWith("/background-jobs/animation-job")) return Response.json({ status: "completed" });
    if (url.endsWith("/characters/animations")) return Response.json({ background_job_ids: ["animation-job"], animation_group_id: "animation" });
    if (url.includes("/characters/character/gif")) return new Response(Buffer.from("GIF89a"), { headers: { "content-type": "image/gif" } });
    throw new Error(`Unexpected PixelLab request: ${url}`);
  }));

  await expect(commands.get("skeletonAnimation")!({
    params: { description: "wizard", action: "run", direction: "east", body: "mannequin" },
    inputs: { reference: [{ path: path.join(output, "source.png"), contentType: "image/png" }] }, output,
  }, { configuration: { apiKey: "secret" } })).resolves.toEqual({ file: "animation.gif" });
  expect(calls.find((call) => call.url.endsWith("/characters/animations"))?.body).toEqual(expect.objectContaining({
    mode: "skeleton-v3", action_description: "run", directions: ["east"], character_id: "character",
  }));
  expect(calls.some((call) => call.url.includes("animate-with-skeleton") || (JSON.stringify(call.body) ?? "").includes("keypoints"))).toBe(false);
  expect(await readFile(path.join(output, "animation.gif"))).toEqual(Buffer.from("GIF89a"));
});
