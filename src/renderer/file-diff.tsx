import { Fragment, memo, useMemo } from "react";
import { lineDiff, type DiffHunk } from "../shared/line-diff.js";
import type { CheckpointFileView } from "../shared/contracts.js";
import { t } from "./i18n.js";

const LINE_SIGNS = { same: " ", added: "+", removed: "-" } as const;

/** Shared view for tool mutations, turn changes and the Git workspace. */
export const FileDiff = memo(function FileDiff({
  hunks,
}: {
  hunks: DiffHunk[];
}) {
  return (
    <div className="turn-change-diff">
      {hunks.map((hunk, index) => (
        <Fragment key={index}>
          {index > 0 ? <hr className="turn-change-gap" /> : null}
          {hunk.map((line, row) => (
            <div
              className={`turn-change-line turn-change-line-${line.kind}`}
              key={row}
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
  );
});

export function FileComparison({
  view,
  maxLines = 2_000,
  unchangedLabel,
}: {
  view: CheckpointFileView;
  maxLines?: number;
  unchangedLabel?: string;
}) {
  const binary = Boolean(view.before?.binary || view.after?.binary);
  const truncated = Boolean(view.before?.truncated || view.after?.truncated);
  const full = useMemo(
    () =>
      binary
        ? []
        : lineDiff(view.before?.content ?? "", view.after?.content ?? ""),
    [view, binary],
  );
  const { hunks, clipped } = useMemo(() => {
    let retained = 0;
    const hunks = full
      .map((hunk) => {
        const shown = hunk.slice(0, Math.max(0, maxLines - retained));
        retained += hunk.length;
        return shown;
      })
      .filter((hunk) => hunk.length);
    return { hunks, clipped: retained > maxLines };
  }, [full, maxLines]);
  if (binary)
    return <p className="turn-changes-note">{t("checkpoints.binary")}</p>;
  return (
    <>
      {hunks.length ? (
        <FileDiff hunks={hunks} />
      ) : (
        <p className="turn-changes-note">
          {!view.before || !view.after
            ? t("checkpoints.emptyFile")
            : truncated
              ? t("checkpoints.samePart")
              : (unchangedLabel ?? t("checkpoints.sameLines"))}
        </p>
      )}
      {(truncated || clipped) && hunks.length ? (
        <p className="turn-changes-note">
          {t(clipped ? "checkpoints.diffTruncated" : "checkpoints.truncated")}
        </p>
      ) : null}
    </>
  );
}
