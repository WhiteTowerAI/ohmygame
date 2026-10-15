import { ChevronRight, FilePenLine } from "./icons.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CheckpointChangeItem,
  CheckpointFileView,
  CheckpointUndoRequest,
  TurnChanges,
} from "../shared/contracts.js";
import { t } from "./i18n.js";
import { ChangeCounts } from "./change-counts.js";
import { FileComparison } from "./file-diff.js";

type FileAction = "undo" | "reapply";

type ConflictChoice = NonNullable<CheckpointUndoRequest["conflicts"]>;

export type TurnUndoOutcome =
  | {
      status: "done";
      changed: string[];
      conflicts: string[];
      undone?: boolean;
      kept?: number;
    }
  | { status: "conflicts"; conflicts: string[]; blocked: boolean }
  | { status: "failed"; message: string };

export interface TurnChangesControls {
  /** No undo can start now. The list and the file views stay available. */
  disabled: boolean;
  load: (checkpointId: string) => Promise<CheckpointChangeItem[]>;
  file: (checkpointId: string, path: string) => Promise<CheckpointFileView>;
  /** With "overwrite", `expected` names the files the user was shown; no other file may be overwritten. */
  undo: (
    checkpointId: string,
    conflicts?: ConflictChoice,
    expected?: string[],
  ) => Promise<TurnUndoOutcome>;
  reapply: TurnChangesControls["undo"];
}

type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "failed"; message: string };

interface FileState {
  open: boolean;
  content?: Loaded<CheckpointFileView>;
}

interface FooterView {
  open: boolean;
  /** Immutable summaries loaded for older turns that did not save them. */
  summary?: CheckpointChangeItem[];
  list?: Loaded<CheckpointChangeItem[]>;
  /** The files whose view was opened, by path. */
  files: Record<string, FileState>;
  /**
   * Where the undo waits for the user, while its panel is shown. A list of
   * conflicts is renewed when it replaces one the user had agreed to overwrite.
   */
  conflict?: {
    direction: FileAction;
    paths: string[];
    blocked: boolean;
    renewed: boolean;
  };
  submitting: boolean;
  result?: {
    changed: number;
    kept: number;
    left: number;
    direction: FileAction;
    undone: boolean;
  };
  error?: string;
}

type UpdateView = (change: (view: FooterView) => FooterView) => void;

interface FooterViews {
  views: Record<string, FooterView>;
  update: (
    checkpointId: string,
    change: (view: FooterView) => FooterView,
  ) => void;
}

const CLOSED: FooterView = { open: false, files: {}, submitting: false };
const FooterViewsContext = createContext<FooterViews | undefined>(undefined);

/**
 * Holds what every footer shows by its checkpoint id, above the turns. A
 * reloaded conversation gives each turn another id and so a new component;
 * kept here, an open list and the outcome of an undo stay with the turn they
 * belong to. One conversation at a time: a checkpoint id is unique only
 * within its conversation. `workspaceRevision` changes whenever the files of
 * the workspace may have changed.
 */
export function TurnChangesViews({
  workspaceRevision,
  children,
}: {
  workspaceRevision?: number;
  children: ReactNode;
}) {
  const [views, setViews] = useState<Record<string, FooterView>>({});
  const revision = useRef(workspaceRevision);
  useEffect(() => {
    if (revision.current === workspaceRevision) return;
    revision.current = workspaceRevision;
    // Only current path states expire. The before/after diffs and summaries
    // belong to immutable checkpoints, so keep them across workspace changes.
    setViews((current) =>
      Object.fromEntries(
        Object.entries(current).map(([checkpointId, view]) => [
          checkpointId,
          {
            ...view,
            list: undefined,
          },
        ]),
      ),
    );
  }, [workspaceRevision]);
  const update = useCallback<FooterViews["update"]>((checkpointId, change) => {
    setViews((current) => {
      const previous = current[checkpointId] ?? CLOSED;
      const next = change(previous);
      return next === previous ? current : { ...current, [checkpointId]: next };
    });
  }, []);
  const value = useMemo(() => ({ views, update }), [views, update]);
  return (
    <FooterViewsContext.Provider value={value}>
      {children}
    </FooterViewsContext.Provider>
  );
}

function useFooterView(checkpointId: string): [FooterView, UpdateView] {
  const shared = useContext(FooterViewsContext);
  if (!shared)
    throw new Error("TurnChangesFooter must be used inside TurnChangesViews");
  const { views, update } = shared;
  return [
    views[checkpointId] ?? CLOSED,
    useCallback(
      (change) => update(checkpointId, change),
      [update, checkpointId],
    ),
  ];
}

/** What one Agent turn changed in the workspace, with a way to look at it and to take it back. */
export function TurnChangesFooter({
  checkpointId,
  changes,
  controls,
}: {
  checkpointId: string;
  changes: TurnChanges;
  controls: TurnChangesControls;
}) {
  const [view, update] = useFooterView(checkpointId);
  const detailsId = useId();
  const { load, file } = controls;
  const disabled = controls.disabled || view.submitting;
  const listed = view.list?.status === "ready" ? view.list.value : undefined;
  const summary = changes.items ?? view.summary;
  const savedLines = useMemo(
    () => new Map(summary?.map((item) => [item.path, item.lines])),
    [summary],
  );
  const items =
    listed?.map((item) => ({
      ...item,
      lines: savedLines.get(item.path) ?? item.lines,
    })) ?? summary;
  const totals = items?.some((item) => item.lines)
    ? items.reduce(
        (total, item) => ({
          added: total.added + (item.lines?.added ?? 0),
          removed: total.removed + (item.lines?.removed ?? 0),
        }),
        { added: 0, removed: 0 },
      )
    : undefined;
  const undone = view.result?.undone ?? Boolean(changes.undone);
  const kept = view.result?.kept ?? changes.kept ?? 0;
  const appliedAgain = listed?.every((item) => item.state === "applied");
  const offer =
    !undone || appliedAgain
      ? "undo"
      : kept || listed?.some((item) => item.state === "applied")
        ? "undoRest"
        : undefined;

  useEffect(() => {
    update((current) =>
      current.result
        ? {
            ...current,
            result: {
              ...current.result,
              undone: Boolean(changes.undone),
              kept: changes.kept ?? 0,
            },
          }
        : current,
    );
  }, [changes.undone, changes.kept, update]);

  useEffect(() => {
    // Older turns need their statistics even while the file list is folded.
    if ((!view.open && summary) || view.list) return;
    startLoad(load(checkpointId), (change) =>
      update((current) => {
        const list = change(current.list);
        return {
          ...current,
          list,
          summary:
            current.summary ??
            (!changes.items && list?.status === "ready"
              ? list.value.map(({ state, ...item }) => item)
              : undefined),
        };
      }),
    );
  }, [
    checkpointId,
    view.open,
    view.list,
    summary,
    changes.items,
    load,
    update,
  ]);

  function toggleList() {
    // A list that failed to load is asked for again when it is reopened.
    update((current) => ({
      ...current,
      open: !current.open,
      list:
        !current.open && current.list?.status === "failed"
          ? undefined
          : current.list,
    }));
  }

  async function changeFiles(
    direction: FileAction,
    conflicts?: ConflictChoice,
    expected?: string[],
  ) {
    if (disabled) return;
    update((current) => ({
      ...current,
      submitting: true,
      error: undefined,
      result: undefined,
    }));
    try {
      const outcome = await controls[direction](
        checkpointId,
        conflicts,
        expected,
      );
      update((current) =>
        afterFileChange(current, outcome, conflicts === "overwrite", direction),
      );
    } finally {
      update((current) => ({ ...current, submitting: false }));
    }
  }

  return (
    <div className="turn-changes">
      <button
        className="turn-changes-summary turn-changes-toggle"
        type="button"
        aria-label={t("checkpoints.filesChanged", { count: changes.files })}
        aria-expanded={view.open}
        aria-controls={detailsId}
        onClick={toggleList}
      >
        <span>{t("checkpoints.filesChanged", { count: changes.files })}</span>
        {totals ? <ChangeCounts lines={totals} /> : null}
        <ChevronRight
          className={`turn-change-chevron${view.open ? " is-open" : ""}`}
          size={14}
          aria-hidden="true"
        />
      </button>
      {view.open ? (
        <div id={detailsId}>
          {!items && (!view.list || view.list.status === "loading") ? (
            <p className="turn-changes-note">
              {t("checkpoints.loadingChanges")}
            </p>
          ) : view.list?.status === "failed" ? (
            <p className="turn-changes-error" role="alert">
              {view.list.message}
            </p>
          ) : items?.length === 0 ? (
            <p className="turn-changes-note">{t("checkpoints.noChanges")}</p>
          ) : (
            <ul className="turn-changes-list">
              {items?.map((item) => (
                <ChangedFile
                  key={item.path}
                  checkpointId={checkpointId}
                  item={item}
                  state={view.files[item.path]}
                  update={update}
                  load={file}
                />
              ))}
            </ul>
          )}
          <div className="turn-changes-controls">
            {offer === "undoRest" ? (
              <span className="turn-changes-undone">
                {t("checkpoints.partlyUndone")}
              </span>
            ) : null}
            {offer ? (
              <button
                className="turn-changes-undo"
                type="button"
                disabled={disabled}
                onClick={() => void changeFiles("undo")}
              >
                {t(`checkpoints.${offer}`)}
              </button>
            ) : null}
            {undone ? (
              <button
                className="turn-changes-undo"
                type="button"
                disabled={disabled}
                onClick={() => void changeFiles("reapply")}
              >
                {t("checkpoints.reapply")}
              </button>
            ) : null}
          </div>
          {view.result ? (
            <p className="turn-changes-result" role="status">
              {resultText(view.result)}
            </p>
          ) : null}
          {view.conflict ? (
            <ConflictPanel
              conflict={view.conflict}
              disabled={disabled}
              submitting={view.submitting}
              onApply={(conflicts, expected) =>
                void changeFiles(view.conflict!.direction, conflicts, expected)
              }
              onCancel={() =>
                update((current) => ({
                  ...current,
                  conflict: undefined,
                  error: undefined,
                }))
              }
            />
          ) : null}
          {view.error ? (
            <p className="turn-changes-error" role="alert">
              {view.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConflictPanel({
  conflict,
  disabled,
  submitting,
  onApply,
  onCancel,
}: {
  conflict: NonNullable<FooterView["conflict"]>;
  disabled: boolean;
  submitting: boolean;
  onApply: (conflicts?: ConflictChoice, expected?: string[]) => void;
  onCancel: () => void;
}) {
  const cancel = (
    <button type="button" disabled={submitting} onClick={onCancel}>
      {t("common.cancel")}
    </button>
  );
  return (
    <div
      className="turn-changes-panel"
      role="group"
      aria-label={t(
        conflict.direction === "reapply"
          ? "checkpoints.reapply"
          : "checkpoints.undoChanges",
      )}
    >
      {conflict.renewed ? <p>{t("checkpoints.renewed")}</p> : null}
      <p>
        {conflict.blocked
          ? t("checkpoints.blockedIntro")
          : t(
              conflict.direction === "reapply"
                ? "checkpoints.reapplyConflicts"
                : "checkpoints.conflictsIntro",
            )}
      </p>
      <ul className="turn-changes-conflicts">
        {conflict.paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
      <p>
        {conflict.blocked
          ? t("checkpoints.blockedHint")
          : t("checkpoints.conflictsHint")}
      </p>
      <div className="turn-changes-actions">
        {conflict.blocked ? (
          <button
            className="primary"
            type="button"
            disabled={disabled}
            onClick={() => onApply("keep")}
          >
            {t(
              conflict.direction === "reapply"
                ? "checkpoints.reapplyRest"
                : "checkpoints.undoRest",
            )}
          </button>
        ) : (
          <>
            <button
              className="primary"
              type="button"
              disabled={disabled}
              onClick={() => onApply("keep")}
            >
              {t("checkpoints.keep")}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onApply("overwrite", conflict.paths)}
            >
              {t("checkpoints.overwrite")}
            </button>
          </>
        )}
        {cancel}
      </div>
    </div>
  );
}

function ChangedFile({
  checkpointId,
  item,
  state,
  update,
  load,
}: {
  checkpointId: string;
  item: CheckpointChangeItem;
  state: FileState | undefined;
  update: UpdateView;
  load: TurnChangesControls["file"];
}) {
  const { path } = item;
  const open = Boolean(state?.open);
  const content = state?.content;
  const label =
    item.state && item.state !== "applied"
      ? t(`checkpoints.state.${item.state}`)
      : undefined;

  useEffect(() => {
    if (!open || content) return;
    startLoad(load(checkpointId, path), (change) =>
      update((current) =>
        withFile(current, path, (file) => ({
          ...file,
          content: change(file.content),
        })),
      ),
    );
  }, [checkpointId, path, open, content, load, update]);

  return (
    <li className="turn-change">
      <button
        className="turn-change-row"
        type="button"
        title={path}
        aria-label={path}
        aria-expanded={open}
        onClick={() =>
          update((current) =>
            withFile(current, path, (file) => ({
              open: !file.open,
              content:
                file.content?.status === "failed" ? undefined : file.content,
            })),
          )
        }
      >
        <span className="turn-change-path">
          <FilePenLine size={12} aria-hidden="true" />
          <span>{path}</span>
        </span>
        {item.lines ? (
          <ChangeCounts lines={item.lines} />
        ) : (
          <span
            className="turn-change-kind"
            title={t(`checkpoints.kind.${item.kind}`)}
            aria-label={t("checkpoints.noLineCounts")}
          >
            —
          </span>
        )}
        {label ? <span className="turn-change-badge">{label}</span> : null}
        <ChevronRight
          className={`turn-change-chevron${open ? " is-open" : ""}`}
          size={12}
          aria-hidden="true"
        />
      </button>
      {open ? (
        !content || content.status === "loading" ? (
          <p className="turn-changes-note">{t("checkpoints.loadingFile")}</p>
        ) : content.status === "failed" ? (
          <p className="turn-changes-error" role="alert">
            {content.message}
          </p>
        ) : (
          <FileComparison view={content.value} />
        )
      ) : null}
    </li>
  );
}

/**
 * Starts a load and stores how it stands. The stored marker tells this load
 * from a later one, whose answer is the one to keep.
 */
function startLoad<T>(
  load: Promise<T>,
  store: (
    change: (current: Loaded<T> | undefined) => Loaded<T> | undefined,
  ) => void,
): void {
  const loading: Loaded<T> = { status: "loading" };
  const settle = (result: Loaded<T>) =>
    store((current) => (current === loading ? result : current));
  store(() => loading);
  void load.then(
    (value) => settle({ status: "ready", value }),
    (error) => settle({ status: "failed", message: errorMessage(error) }),
  );
}

function withFile(
  view: FooterView,
  path: string,
  change: (file: FileState) => FileState,
): FooterView {
  return {
    ...view,
    files: {
      ...view.files,
      [path]: change(view.files[path] ?? { open: false }),
    },
  };
}

function afterFileChange(
  view: FooterView,
  outcome: TurnUndoOutcome,
  overwriting: boolean,
  direction: FileAction,
): FooterView {
  if (outcome.status === "failed") return { ...view, error: outcome.message };
  // Told to overwrite the files that were shown, the undo is refused with another list only when other files are in the way by now.
  if (outcome.status === "conflicts")
    return {
      ...view,
      conflict: {
        direction,
        paths: outcome.conflicts,
        blocked: outcome.blocked,
        renewed: overwriting && !outcome.blocked,
      },
    };
  // The list is dropped, to be loaded again: its files stand differently now.
  return {
    ...view,
    conflict: undefined,
    list: undefined,
    result: {
      changed: outcome.changed.length,
      kept: outcome.kept ?? outcome.conflicts.length,
      left: outcome.conflicts.length,
      direction,
      undone: outcome.undone ?? direction === "undo",
    },
  };
}

function resultText({
  changed,
  left,
  direction,
}: {
  changed: number;
  left: number;
  direction: FileAction;
}): string {
  const put =
    direction === "reapply"
      ? t("checkpoints.reapplied", { count: changed })
      : changed === 0
        ? t("checkpoints.nonePutBack")
        : t("checkpoints.putBack", { count: changed });
  if (left === 0) return put;
  return `${put} ${t("checkpoints.kept", { count: left })}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
