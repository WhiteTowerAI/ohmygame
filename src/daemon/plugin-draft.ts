import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PluginDraft } from "../shared/plugin-setup.js";
import { PERSONAL_MARKETPLACE, PLUGIN_SKILL_CONTENT_MAX_BYTES } from "../shared/plugins.js";
import { inspectPluginBundle, validatePluginBundle } from "./local-plugins.js";

export async function pluginDraftPath(workspace: string, requested: string): Promise<string> {
  const [root, target] = await Promise.all([realpath(workspace), realpath(path.resolve(workspace, requested))]);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Plugin draft must be inside this builder's workspace");
  return target;
}

export async function inspectPluginDraft(root: string, installedRevision?: string): Promise<PluginDraft> {
  const draft: PluginDraft = { files: [], errors: [], installedRevision };
  try {
    await validatePluginBundle(root);
    const hash = createHash("sha256");
    async function visit(directory: string): Promise<void> {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(target);
        else {
          const relative = path.relative(root, target).split(path.sep).join("/");
          const bytes = await readFile(target);
          draft.files.push({ path: relative, size: bytes.length });
          hash.update(relative).update("\0").update(String(bytes.length)).update("\0").update(bytes);
        }
      }
    }
    await visit(root);
    draft.revision = hash.digest("hex");
    draft.plugin = { ...await inspectPluginBundle(root, {
      idPrefix: "personal:", marketplace: PERSONAL_MARKETPLACE, source: { type: "directory" },
    }), installed: false };
  } catch (cause) {
    draft.errors.push(cause instanceof Error ? cause.message : String(cause));
  }
  return draft;
}

export async function readPluginDraftFile(root: string, requested: string): Promise<{ path: string; content: string }> {
  if (!requested || path.isAbsolute(requested)) throw new Error("Choose a file in the plugin draft");
  const target = await pluginDraftPath(root, requested);
  const info = await stat(target);
  if (!info.isFile() || info.size > PLUGIN_SKILL_CONTENT_MAX_BYTES) throw new Error("Preview supports files up to 512 KB");
  const bytes = await readFile(target);
  if (bytes.includes(0)) throw new Error("This file cannot be previewed as text");
  return { path: requested, content: bytes.toString("utf8") };
}
