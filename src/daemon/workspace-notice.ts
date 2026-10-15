import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type { ProjectState } from "../shared/contracts.js";
import { writeAtomically } from "./checkpoint-objects.js";

type Project = Pick<ProjectState, "workspacePath" | "storagePath">;
const noticePath = (project: Project) =>
  path.join(
    project.storagePath ?? path.dirname(project.workspacePath),
    "workspace-restore-notice.txt",
  );
/** Outside creative files: an interrupted restore must still inform future
 * model requests even if recording an individual session failed. */
export async function writeWorkspaceNotice(
  project: Project,
  notice: string,
  version: string = randomUUID(),
): Promise<void> {
  const target = noticePath(project);
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomically(
    path.dirname(target),
    target,
    `[workspace-version:${version}]\n${notice}`,
  );
}
export async function readWorkspaceNotice(
  project: Project,
): Promise<string | undefined> {
  try {
    return (await readFile(noticePath(project), "utf8")).replace(
      /^\[workspace-version:[^\]]+\]\n/,
      "",
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}
export async function readWorkspaceVersion(project: Project): Promise<string> {
  try {
    return (
      /^\[workspace-version:([a-f0-9-]{36})\]/.exec(
        await readFile(noticePath(project), "utf8"),
      )?.[1] ?? "0"
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "0";
    throw cause;
  }
}
