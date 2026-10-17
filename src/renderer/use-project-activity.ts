import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { ProjectAgentActivity, ProjectState } from "../shared/contracts.js";
import { listProjectActivity } from "./api.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";

type ProjectActivity = ReadonlyMap<string, ProjectAgentActivity["status"]>;

/** Refresh project cards together instead of polling separately for every card. */
export function useProjectActivity(enabled: boolean, setProjects?: Dispatch<SetStateAction<ProjectState[]>>): ProjectActivity {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [activity, setActivity] = useState<ProjectActivity>(() => new Map());

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let pending = false;
    async function refreshActivity(): Promise<void> {
      if (pending || document.hidden || controller.signal.aborted) return;
      pending = true;
      try {
        const { activity: current, names } = await listProjectActivity(controller.signal);
        if (controller.signal.aborted) return;
        setActivity((previous) => (
          previous.size === current.length && current.every(({ projectId, status }) => previous.get(projectId) === status)
            ? previous : new Map(current.map(({ projectId, status }) => [projectId, status]))
        ));
        if (setProjects) {
          const latest = new Map(names.map((project) => [project.id, project]));
          setProjects((previous) => {
            let changed = false;
            const next = previous.map((project) => {
              const named = latest.get(project.id);
              if (project.nameSource !== "default" || !named?.nameSource || named.nameSource === "default") return project;
              changed = true;
              return { ...project, name: named.name, nameSource: named.nameSource };
            });
            return changed ? next : previous;
          });
        }
      } catch {
        // Keep the last state during a temporary runtime disconnect.
      } finally {
        pending = false;
      }
    }
    const refresh = () => { void refreshActivity(); };
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, serviceGeneration, setProjects]);

  return activity;
}
