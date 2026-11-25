import type { LineChanges } from "../shared/contracts.js";
import { t } from "./i18n.js";

export function ChangeCounts({ lines }: { lines: LineChanges }) {
  return (
    <span
      className="change-counts"
      aria-label={t("checkpoints.lineCounts", { ...lines })}
    >
      <span className={`change-count-added${lines.added ? "" : " is-zero"}`} aria-hidden="true">
        +{lines.added}
      </span>
      <span className={`change-count-removed${lines.removed ? "" : " is-zero"}`} aria-hidden="true">
        -{lines.removed}
      </span>
    </span>
  );
}
