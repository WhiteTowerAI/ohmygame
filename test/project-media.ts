import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolMediaFiles } from "../src/daemon/tools.js";
import { getWorkspaceMedia } from "../src/daemon/workspace.js";

/**
 * A project's media as a tool reads its references: `files` written into a
 * folder of `directory`, found by their paths in the project `project`.
 */
export async function projectMedia(directory: string, files: Record<string, Uint8Array>): Promise<ToolMediaFiles> {
  const folder = path.join(directory, "project");
  await mkdir(folder, { recursive: true });
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(folder, name), contents);
  return async (projectId, filePath) => {
    if (projectId !== "project") throw new Error("Project not found");
    const media = await getWorkspaceMedia(folder, filePath);
    return { name: path.basename(media.relativePath), absolutePath: media.absolutePath, mediaType: media.mediaType, contentType: media.contentType, size: media.size };
  };
}
