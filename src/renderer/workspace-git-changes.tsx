import { useEffect, useState } from "react";
import type {
  WorkspaceGitChanges,
  WorkspaceGitFileView,
} from "../shared/workspace-git.js";
import { getWorkspaceGitChanges, getWorkspaceGitFile } from "./api.js";
import { ChangeCounts } from "./change-counts.js";
import { FileComparison } from "./file-diff.js";
import { LoaderCircle } from "./icons.js";
import { t } from "./i18n.js";

export function useWorkspaceGitChanges(
  projectId: string | undefined,
  revision: number,
  filesRevision: number,
) {
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{
    projectId?: string;
    data?: WorkspaceGitChanges;
    error?: string;
    loading: boolean;
  }>({ loading: false });
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    setState((current) => ({
      projectId,
      data: current.projectId === projectId ? current.data : undefined,
      loading: true,
    }));
    void getWorkspaceGitChanges(projectId).then(
      (data) => {
        if (!disposed) setState({ projectId, data, loading: false });
      },
      (cause) => {
        if (!disposed)
          setState((current) => ({
            ...current,
            error: errorMessage(cause),
            loading: false,
          }));
      },
    );
    return () => {
      disposed = true;
    };
  }, [projectId, revision, filesRevision, refresh]);
  return {
    ...(state.projectId === projectId ? state : { loading: false }),
    refresh: () => setRefresh((value) => value + 1),
  };
}

export function GitChangesList({
  data,
  loading,
  error,
  search,
  selectedPath,
  onSelect,
}: {
  data?: WorkspaceGitChanges;
  loading: boolean;
  error?: string;
  search: string;
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  if (error)
    return (
      <p className="git-changes-note" role="alert">
        {error}
      </p>
    );
  if (!data)
    return (
      <p className="git-changes-note">
        {loading ? t("workspace.gitLoading") : t("workspace.gitClean")}
      </p>
    );
  const filtered = data.changes.filter((item) =>
    item.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <div
      className="git-changes-list"
      aria-label={t("workspace.gitChanges")}
      aria-busy={loading}
    >
      {!filtered.length ? (
        <p className="git-changes-note">
          {data.changes.length
            ? t("workspace.gitNoMatch")
            : t("workspace.gitClean")}
        </p>
      ) : (
        filtered.map((item) => (
          <button
            type="button"
            key={item.path}
            className={`git-change-row${item.path === selectedPath ? " is-selected" : ""}`}
            aria-pressed={item.path === selectedPath}
            title={item.path}
            onClick={() => onSelect(item.path)}
          >
            <span
              className={`git-change-kind git-change-kind-${item.kind}`}
              title={
                item.untracked
                  ? t("workspace.gitUntracked")
                  : t(`checkpoints.kind.${item.kind}`)
              }
            >
              {item.conflicted
                ? "!"
                : item.kind === "added"
                  ? "A"
                  : item.kind === "removed"
                    ? "D"
                    : "M"}
            </span>
            <span className="git-change-path">{item.path}</span>
            {item.lines ? (
              <ChangeCounts lines={item.lines} />
            ) : (
              <span className="git-change-unknown">—</span>
            )}
          </button>
        ))
      )}
    </div>
  );
}

export function WorkspaceGitDiff({
  projectId,
  path,
  changes,
}: {
  projectId: string;
  path?: string;
  changes?: WorkspaceGitChanges;
}) {
  const [state, setState] = useState<{
    view?: WorkspaceGitFileView;
    error?: string;
  }>({});
  useEffect(() => {
    setState({});
    if (!path) return;
    let disposed = false;
    void getWorkspaceGitFile(projectId, path).then(
      (view) => {
        if (!disposed) setState({ view });
      },
      (cause) => {
        if (!disposed) setState({ error: errorMessage(cause) });
      },
    );
    return () => {
      disposed = true;
    };
  }, [projectId, path, changes]);
  if (!path)
    return <div className="workspace-state">{t("workspace.gitClean")}</div>;
  const { view, error } = state;
  const item = changes?.changes.find((item) => item.path === path);
  return (
    <>
      <div className="file-content-header">
        <span className="file-content-path" title={path}>
          {path}
        </span>
        {item?.lines ? <ChangeCounts lines={item.lines} /> : null}
        <span className="git-diff-base">
          {t(changes?.head ? "workspace.gitBase" : "workspace.gitFirstCommit")}
        </span>
      </div>
      <div className="git-diff-content">
        {error ? (
          <p className="git-changes-note" role="alert">
            {error}
          </p>
        ) : !view ? (
          <div className="workspace-state">
            <LoaderCircle className="spin" size={18} />
            {t("workspace.loadingFile")}
          </div>
        ) : view.unsupported ? (
          <p className="git-changes-note">{t("workspace.gitUnsupported")}</p>
        ) : view.before?.truncated || view.after?.truncated ? (
          <p className="git-changes-note">{t("workspace.gitTooLarge")}</p>
        ) : (
          <FileComparison
            view={view}
            maxLines={500}
            unchangedLabel={t("workspace.gitNoTextChanges")}
          />
        )}
      </div>
    </>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
