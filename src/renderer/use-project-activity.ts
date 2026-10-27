import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { ProjectAgentActivity, ProjectState } from "../shared/contracts.js";
import { streamProjectActivity } from "./api.js";

type ProjectActivity = ReadonlyMap<string, ProjectAgentActivity["status"]>;

/** Follow activity for all project cards together over one stream. */
export function useProjectActivity(enabled: boolean, setProjects?: Dispatch<SetStateAction<ProjectState[]>>): ProjectActivity {
  const [activity, setActivity] = useState<ProjectActivity>(() => new Map());

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void streamProjectActivity(controller.signal, ({ activity: current, names }) => {
      setActivity((previous) => (
        previous.size === current.length && current.every(({ projectId, status }) => previous.get(projectId) === status)
          ? previous : new Map(current.map(({ projectId, status }) => [projectId, status]))
      ));
      if (!setProjects) return;
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
    });
    return () => controller.abort();
  }, [enabled, setProjects]);

  return activity;
}
