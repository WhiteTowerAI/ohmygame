import { useEffect, useRef, useReducer } from "react";
import type { CanvasWorkspaceDetail } from "../shared/canvas-workspace.js";
import { CanvasTableStorage } from "./canvas-table-storage.js";
import { Equal } from "typebox/value";

export function useCanvasTables(
  projectId: string,
  workspace?: CanvasWorkspaceDetail,
) {
  const session = useRef<CanvasTableStorage | undefined>(undefined);
  if (session.current?.projectId !== projectId)
    session.current = new CanvasTableStorage(projectId);
  const storage = session.current;
  const [version, render] = useReducer((value) => value + 1, 0);
  useEffect(() => storage.subscribe(render), [storage]);
  const loaded = Boolean(workspace),
    tables = workspace?.tables,
    issues = workspace?.tableIssues;
  useEffect(() => {
    if (loaded) void storage.sync({ tables, tableIssues: issues });
  }, [storage, loaded, tables, issues]);
  const dirty = [...storage.sessions.values()].some(
    (session) =>
      !session.conflict &&
      !session.issue &&
      !Equal(session.local, session.base.table),
  );
  useEffect(() => {
    if (!dirty || storage.saving || storage.error) return;
    const timer = window.setTimeout(() => {
      void storage.flush().catch(() => {});
    }, 600);
    return () => window.clearTimeout(timer);
  }, [storage, version, dirty]);
  return storage;
}
