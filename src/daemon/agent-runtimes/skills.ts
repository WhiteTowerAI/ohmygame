import { cp, mkdir, readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Copies Skill folders into a folder of the session's own, where a CLI is
 * told to look. Symbolic links are excluded so staging cannot copy credential
 * files from outside the Skill or expose the plugin's installation. Names keep the first
 * Skill that has them, as Pi does.
 */
export async function stageSkills(
  directories: readonly string[],
  target: string,
): Promise<string[]> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const staged: string[] = [];
  const names = new Set<string>();
  for (const directory of directories) {
    const name = path.basename(directory);
    if (!name || names.has(name)) continue;
    try {
      if (!(await lstat(path.join(directory, "SKILL.md"))).isFile()) continue;
    } catch {
      continue;
    }
    names.add(name);
    await cp(await realpath(directory), path.join(target, name), {
      recursive: true,
      dereference: false,
      filter: async (source) => !(await lstat(source)).isSymbolicLink(),
      force: true,
    });
    staged.push(name);
  }
  return staged;
}

/** The Skill folders inside a folder of Skills, such as OhMyGame's own in the Pi agent folder. */
export async function skillFolders(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}
