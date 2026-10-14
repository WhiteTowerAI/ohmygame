import { ChevronRight, FilePenLine } from "./icons.js";
import {
  createContext,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import { lineDiff, type DiffHunk } from "./line-diff.js";

type ConflictChoice = NonNullable<CheckpointUndoRequest["conflicts"]>;

export type TurnUndoOutcome =
  | { status: "done"; changed: string[]; conflicts: string[] }
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
  list?: Loaded<CheckpointChangeItem[]>;
  /** The files whose view was opened, by path. */
  files: Record<string, FileState>;
  /**
   * Where the undo waits for the user, while its panel is shown. A list of
   * conflicts is renewed when it replaces one the user had agreed to overwrite.
   */
  undo?:
    | { step: "confirm" }
    | {
        step: "conflicts";
        paths: string[];
        blocked: boolean;
        renewed: boolean;
      };
  submitting: boolean;
  result?: { changed: number; kept: number };
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
/** How many files the undo confirmation names before it only counts them. */
const NAMED_FILES = 10;
const LINE_SIGNS = { same: " ", added: "+", removed: "-" } as const;
/** The most lines a file view draws; a longer diff ends with a count of the rest. */
const MAX_SHOWN_LINES = 2_000;
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
  useEffect(() => {
    // What was loaded says how the files stood before, so it is dropped; what is open loads again.
    setViews((current) =>
      Object.fromEntries(
        Object.entries(current).map(([checkpointId, view]) => [
          checkpointId,
          {
            ...view,
            list: undefined,
            files: Object.fromEntries(
              Object.entries(view.files).map(([path, file]) => [
                path,
                { open: file.open },
              ]),
            ),
          },
        ]),
      ),
    );
  }, [workspaceRevision]);
  const update = useCallback<FooterViews["update"]>((checkpointId, change) => {
    setViews((current) => ({
      ...current,
      [checkpointId]: change(current[checkpointId] ?? CLOSED),
    }));
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
  const { load, file } = controls;
  const disabled = controls.disabled || view.submitting;
  const listed = view.list?.status === "ready" ? view.list.value : undefined;
  // An undone turn can be undone again: for the files that were kept, and when the list shows a change of it in place again.
  const offer = !changes.undone
    ? "undo"
    : changes.kept
      ? "undoRest"
      : listed?.some(
            (item) => item.state === "applied" || item.state === "changed",
          )
        ? "undo"
        : undefined;
  const listWanted = view.open || Boolean(view.undo);

  useEffect(() => {
    if (!listWanted || view.list) return;
    startLoad(load(checkpointId), (change) =>
      update((current) => ({ ...current, list: change(current.list) })),
    );
  }, [checkpointId, listWanted, view.list, load, update]);

  function toggleList() {
    // A list that failed to load is asked for again when it is reopened.
    update((current) => ({
      ...current,
      open: !current.open,
      list: current.list?.status === "failed" ? undefined : current.list,
    }));
  }

  async function undo(conflicts?: ConflictChoice, expected?: string[]) {
    if (disabled) return;
    update((current) => ({
      ...current,
      submitting: true,
      error: undefined,
      result: undefined,
    }));
    try {
      const outcome = await controls.undo(checkpointId, conflicts, expected);
      update((current) =>
        afterUndo(current, outcome, conflicts === "overwrite"),
      );
    } finally {
      update((current) => ({ ...current, submitting: false }));
    }
  }

  return (
    <div className="turn-changes">
      <div className="turn-changes-summary">
        <FilePenLine size={13} />
        <button
          className="turn-changes-toggle"
          type="button"
          aria-expanded={view.open}
          onClick={toggleList}
        >
          <span>{t("checkpoints.filesChanged", { count: changes.files })}</span>
          <ChevronRight className="turn-changes-chevron" size={12} />
        </button>
        {offer === "undoRest" ? (
          <span className="turn-changes-undone">
            {t("checkpoints.partlyUndone")}
          </span>
        ) : null}
        {offer ? (
          <button
            className="turn-changes-undo"
            type="button"
            aria-expanded={Boolean(view.undo)}
            disabled={disabled}
            onClick={() =>
              update((current) => ({
                ...current,
                undo: current.undo ? undefined : { step: "confirm" },
                error: undefined,
                result: undefined,
              }))
            }
          >
            {t(`checkpoints.${offer}`)}
          </button>
        ) : (
          <span className="turn-changes-undone">{t("checkpoints.undone")}</span>
        )}
      </div>
      {view.result ? (
        <p className="turn-changes-result" role="status">
          {resultText(view.result)}
        </p>
      ) : null}
      {view.undo && offer ? (
        <UndoPanel
          step={view.undo}
          list={view.list}
          disabled={disabled}
          submitting={view.submitting}
          onUndo={(conflicts, expected) => void undo(conflicts, expected)}
          onReload={() =>
            update((current) => ({ ...current, list: undefined }))
          }
          onCancel={() =>
            update((current) => ({
              ...current,
              undo: undefined,
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
      {view.open ? (
        !view.list || view.list.status === "loading" ? (
          <p className="turn-changes-note">{t("checkpoints.loadingChanges")}</p>
        ) : view.list.status === "failed" ? (
          <p className="turn-changes-error" role="alert">
            {view.list.message}
          </p>
        ) : view.list.value.length === 0 ? (
          <p className="turn-changes-note">{t("checkpoints.noChanges")}</p>
        ) : (
          <ul className="turn-changes-list">
            {view.list.value.map((item) => (
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
        )
      ) : null}
    </div>
  );
}

function UndoPanel({
  step,
  list,
  disabled,
  submitting,
  onUndo,
  onReload,
  onCancel,
}: {
  step: NonNullable<FooterView["undo"]>;
  list: FooterView["list"];
  disabled: boolean;
  submitting: boolean;
  onUndo: (conflicts?: ConflictChoice, expected?: string[]) => void;
  onReload: () => void;
  onCancel: () => void;
}) {
  const cancel = (
    <button type="button" disabled={submitting} onClick={onCancel}>
      {t("common.cancel")}
    </button>
  );
  if (step.step === "confirm") {
    // A file that is already back as it was is left alone, so it is not named.
    const files =
      list?.status === "ready"
        ? list.value.filter((item) => item.state !== "undone")
        : undefined;
    return (
      <div
        className="turn-changes-panel"
        role="group"
        aria-label={t("checkpoints.undoChanges")}
      >
        {!files ? (
          list?.status === "failed" ? (
            <p className="turn-changes-error" role="alert">
              {list.message}
            </p>
          ) : (
            <p className="turn-changes-note">
              {t("checkpoints.loadingChanges")}
            </p>
          )
        ) : files.length === 0 ? (
          <p>{t("checkpoints.allBack")}</p>
        ) : (
          <>
            <p>{t("checkpoints.confirm", { count: files.length })}</p>
            <ul className="turn-changes-files">
              {files.slice(0, NAMED_FILES).map((item) => (
                <li key={item.path}>
                  <span className={`turn-change-kind turn-change-${item.kind}`}>
                    {t(`checkpoints.kind.${item.kind}`)}
                  </span>
                  <span className="turn-changes-file-path">{item.path}</span>
                  {item.state === "changed" ? (
                    <span className="turn-change-badge">
                      {t("checkpoints.state.changed")}
                    </span>
                  ) : null}
                </li>
              ))}
              {files.length > NAMED_FILES ? (
                <li>
                  {t("checkpoints.andMore", {
                    count: files.length - NAMED_FILES,
                  })}
                </li>
              ) : null}
            </ul>
            <p>{t("checkpoints.everythingListed")}</p>
          </>
        )}
        <div className="turn-changes-actions">
          <button
            className="primary"
            type="button"
            disabled={disabled || !files}
            onClick={() => onUndo()}
          >
            {t("checkpoints.undoChanges")}
          </button>
          {list?.status === "failed" ? (
            <button type="button" onClick={onReload}>
              {t("common.tryAgain")}
            </button>
          ) : null}
          {cancel}
        </div>
      </div>
    );
  }
  return (
    <div
      className="turn-changes-panel"
      role="group"
      aria-label={t("checkpoints.undoChanges")}
    >
      {step.renewed ? <p>{t("checkpoints.renewed")}</p> : null}
      <p>
        {step.blocked
          ? t("checkpoints.blockedIntro")
          : t("checkpoints.conflictsIntro")}
      </p>
      <ul className="turn-changes-conflicts">
        {step.paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
      <p>
        {step.blocked
          ? t("checkpoints.blockedHint")
          : t("checkpoints.conflictsHint")}
      </p>
      <div className="turn-changes-actions">
        {step.blocked ? (
          <button
            className="primary"
            type="button"
            disabled={disabled}
            onClick={() => onUndo("keep")}
          >
            {t("checkpoints.undoRest")}
          </button>
        ) : (
          <>
            <button
              className="primary"
              type="button"
              disabled={disabled}
              onClick={() => onUndo("keep")}
            >
              {t("checkpoints.keep")}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onUndo("overwrite", step.paths)}
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
      <div className="turn-change-row">
        <span className={`turn-change-kind turn-change-${item.kind}`}>
          {t(`checkpoints.kind.${item.kind}`)}
        </span>
        <button
          className="turn-change-path"
          type="button"
          title={path}
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
          {path}
        </button>
        {label ? <span className="turn-change-badge">{label}</span> : null}
      </div>
      {open ? (
        !content || content.status === "loading" ? (
          <p className="turn-changes-note">{t("checkpoints.loadingFile")}</p>
        ) : content.status === "failed" ? (
          <p className="turn-changes-error" role="alert">
            {content.message}
          </p>
        ) : (
          <FileChanges view={content.value} />
        )
      ) : null}
    </li>
  );
}

// Kept from drawing again while the footer around it changes: a diff can have thousands of lines.
const FileChanges = memo(function FileChanges({
  view,
}: {
  view: CheckpointFileView;
}) {
  const binary = Boolean(view.before?.binary || view.after?.binary);
  // Of a longer file only the beginning was read, so a change beyond it is not seen here.
  const truncated = Boolean(view.before?.truncated || view.after?.truncated);
  // A side that is not there compares as an empty text, so the other side shows whole.
  const { hunks, hidden } = useMemo(
    () =>
      shownLines(
        binary
          ? []
          : lineDiff(view.before?.content ?? "", view.after?.content ?? ""),
      ),
    [view, binary],
  );
  if (binary)
    return <p className="turn-changes-note">{t("checkpoints.binary")}</p>;
  return (
    <>
      {hunks.length ? (
        <div className="turn-change-diff">
          {hunks.map((hunk, index) => (
            <Fragment key={index}>
              {index > 0 ? <hr className="turn-change-gap" /> : null}
              {hunk.map((line) => (
                <div
                  className={`turn-change-line turn-change-line-${line.kind}`}
                  key={`${line.before ?? ""}:${line.after ?? ""}`}
                >
                  <span className="turn-change-line-number">{line.before}</span>
                  <span className="turn-change-line-number">{line.after}</span>
                  <span className="turn-change-line-sign">
                    {LINE_SIGNS[line.kind]}
                  </span>
                  <span className="turn-change-line-text">{line.text}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      ) : (
        <p className="turn-changes-note">
          {!view.before || !view.after
            ? t("checkpoints.emptyFile")
            : truncated
              ? t("checkpoints.samePart")
              : t("checkpoints.sameLines")}
        </p>
      )}
      {hidden ? (
        <p className="turn-changes-note">
          {t("checkpoints.moreLines", { count: hidden })}
        </p>
      ) : null}
      {truncated && hunks.length ? (
        <p className="turn-changes-note">{t("checkpoints.truncated")}</p>
      ) : null}
    </>
  );
});

/** The hunks cut to `MAX_SHOWN_LINES` lines, and how many lines were left out. */
function shownLines(all: DiffHunk[]): { hunks: DiffHunk[]; hidden: number } {
  const hunks: DiffHunk[] = [];
  let room = MAX_SHOWN_LINES;
  let hidden = 0;
  for (const hunk of all) {
    if (room > 0) hunks.push(hunk.slice(0, room));
    hidden += Math.max(hunk.length - room, 0);
    room = Math.max(room - hunk.length, 0);
  }
  return { hunks, hidden };
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

function afterUndo(
  view: FooterView,
  outcome: TurnUndoOutcome,
  overwriting: boolean,
): FooterView {
  if (outcome.status === "failed") return { ...view, error: outcome.message };
  // Told to overwrite the files that were shown, the undo is refused with another list only when other files are in the way by now.
  if (outcome.status === "conflicts")
    return {
      ...view,
      undo: {
        step: "conflicts",
        paths: outcome.conflicts,
        blocked: outcome.blocked,
        renewed: overwriting && !outcome.blocked,
      },
    };
  // The list is dropped, to be loaded again: its files stand differently now.
  return {
    ...view,
    undo: undefined,
    list: undefined,
    result: { changed: outcome.changed.length, kept: outcome.conflicts.length },
  };
}

function resultText({
  changed,
  kept,
}: {
  changed: number;
  kept: number;
}): string {
  const put =
    changed === 0
      ? t("checkpoints.nonePutBack")
      : t("checkpoints.putBack", { count: changed });
  if (kept === 0) return put;
  return `${put} ${t("checkpoints.kept", { count: kept })}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
