import { useEffect, useState } from "react";
import type { ProjectAgentActivity } from "../shared/contracts.js";
import { listProjectActivity } from "./api.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";

type ProjectActivity = ReadonlyMap<string, ProjectAgentActivity["status"]>;

/** Refresh project cards together instead of polling separately for every card. */
export function useProjectActivity(enabled: boolean): ProjectActivity {
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
        const current = await listProjectActivity(controller.signal);
        if (!controller.signal.aborted) {
          setActivity((previous) => (
            previous.size === current.length && current.every(({ projectId, status }) => previous.get(projectId) === status)
              ? previous : new Map(current.map(({ projectId, status }) => [projectId, status]))
          ));
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
  }, [enabled, serviceGeneration]);

  return activity;
}
