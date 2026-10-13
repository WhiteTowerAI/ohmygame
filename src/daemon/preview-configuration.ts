import { realpath } from "node:fs/promises";
import type { ProjectState } from "../shared/contracts.js";
import { resolvePreviewWorkspace } from "./projects.js";
import { previewDependencyDirectory } from "./preview-launch.js";
import {
  resolvePackageManager,
  resolvePackageManagerExecutable,
} from "./package-manager.js";
import { projectProcessEnvironment } from "./project-process.js";

/** Reads the environment without installing dependencies or starting project code. */
export async function inspectPreviewConfiguration(
  project: ProjectState,
): Promise<{
  mode?: string;
  manager?: string;
  source?: string;
  error?: string;
}> {
  try {
    const workspace = await resolvePreviewWorkspace(project);
    if (!workspace.runnable)
      return { mode: workspace.mode, error: workspace.error };
    if (workspace.mode !== "script") return { mode: workspace.mode };
    const directory = await previewDependencyDirectory(
      await realpath(project.workspacePath),
      workspace.absolutePath,
    );
    const { manager, source } = await resolvePackageManager(
      directory,
      project.packageManager,
    );
    try {
      await resolvePackageManagerExecutable(
        manager,
        projectProcessEnvironment(),
      );
    } catch (cause) {
      return {
        mode: "script",
        manager,
        source,
        error: (cause as Error).message,
      };
    }
    return { mode: "script", manager, source };
  } catch (cause) {
    return { error: (cause as Error).message };
  }
}
