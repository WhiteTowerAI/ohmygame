import { useEffect, useRef, useReducer } from "react";
import type { CanvasWorkspaceDetail } from "../shared/canvas-workspace.js";
import { CanvasTableStorage } from "./canvas-table-storage.js";
import { Equal } from "typebox/value";
import { useDesktopClosing } from "./desktop-close-guard.js";
import { isDesktopClosing } from "./desktop-save.js";

export function useCanvasTables(
  projectId: string,
  workspace?: CanvasWorkspaceDetail,
) {
  const closing = useDesktopClosing();
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
    if (loaded && !closing) void storage.sync({ tables, tableIssues: issues });
  }, [storage, loaded, tables, issues, closing]);
  const dirty = [...storage.sessions.values()].some(
    (session) =>
      !session.conflict &&
      !session.issue &&
      !Equal(session.local, session.base.table),
  );
  useEffect(() => {
    if (!dirty || storage.saving || storage.error || closing) return;
    const timer = window.setTimeout(() => {
      if (!isDesktopClosing()) void storage.flush().catch(() => {});
    }, 600);
    return () => window.clearTimeout(timer);
  }, [storage, version, dirty, closing]);
  return storage;
}
