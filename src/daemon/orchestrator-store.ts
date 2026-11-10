import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ORCHESTRATOR_STORE_VERSION, type OrchestratorConfig } from "../shared/orchestrator.js";

type OrchestratorProject = { storagePath?: string; workspacePath: string };

/** Saved beside the project's conversations, outside the workspace the agents edit. */
export function orchestratorFile(project: OrchestratorProject): string {
  const root = project.storagePath ?? path.dirname(project.workspacePath);
  return path.join(root, "orchestrator.json");
}

export class OrchestratorStoreUnreadableError extends Error {
  constructor(
    readonly reason: "newer-version" | "damaged",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Undefined when nothing was saved yet. A file this build cannot understand is
 * left exactly as it is, so a newer version's data is never replaced.
 */
export async function loadOrchestratorConfig(project: OrchestratorProject): Promise<OrchestratorConfig | undefined> {
  let text: string;
  try {
    text = await readFile(orchestratorFile(project), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OrchestratorStoreUnreadableError("damaged", "The saved team is not valid JSON.");
  }
  const config = parsed as Partial<OrchestratorConfig> | null;
  if (typeof config?.version !== "number" || !Array.isArray(config.roles)) {
    throw new OrchestratorStoreUnreadableError("damaged", "The saved team is missing its version or roster.");
  }
  if (config.version > ORCHESTRATOR_STORE_VERSION) {
    throw new OrchestratorStoreUnreadableError(
      "newer-version",
      `This team was saved by a newer OhMyGame (version ${config.version}). Update to read it.`,
    );
  }
  // Version 1 is the only shape so far; a later version adds its migration step here.
  return config as OrchestratorConfig;
}

/** Written through a temporary file, so a crash mid-write cannot leave a partial store. */
export async function saveOrchestratorConfig(project: OrchestratorProject, config: OrchestratorConfig): Promise<void> {
  const file = orchestratorFile(project);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

/** Deletes the store, and only the store. A file that is not there is already the wanted result. */
export async function removeOrchestratorConfig(project: OrchestratorProject): Promise<void> {
  await rm(orchestratorFile(project), { force: true });
}
