import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ASSET_METADATA_FILE = path.join(".data", "assets.json");

interface AssetMetadata {
  version: 1;
  prompts: Record<string, string>;
}

export async function readAssetPrompts(workspacePath: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(workspacePath, ASSET_METADATA_FILE), "utf8"));
    return isAssetMetadata(parsed) ? parsed.prompts : {};
  } catch {
    return {};
  }
}

export async function writeAssetPrompt(workspacePath: string, assetPath: string, prompt: string): Promise<void> {
  const metadata: AssetMetadata = { version: 1, prompts: await readAssetPrompts(workspacePath) };
  metadata.prompts[assetPath] = prompt;
  const destination = path.join(workspacePath, ASSET_METADATA_FILE);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isAssetMetadata(value: unknown): value is AssetMetadata {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return false;
  const prompts = (value as { prompts?: unknown }).prompts;
  return prompts !== null && typeof prompts === "object" && Object.entries(prompts).every(([assetPath, prompt]) => (
    Boolean(assetPath) && typeof prompt === "string" && Boolean(prompt.trim())
  ));
}
