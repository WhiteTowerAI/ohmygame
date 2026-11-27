import { useEffect, useRef, useState } from "react";
import type { CheckpointHistory, ProjectState } from "../shared/contracts.js";
import {
  clearCheckpointHistory,
  getCheckpointHistory,
  getFileHistorySettings,
  setFileHistorySettings,
} from "./api.js";
import { formatBytes } from "./format-bytes.js";
import { language, t } from "./i18n.js";
import { ChevronLeft, ChevronRight, Clock, Trash2 } from "./icons.js";
import {
  Button,
  Dialog,
  Popover,
  SegmentedControl,
  Select,
  Spinner,
} from "./ui/index.js";
import { SettingsNote, SettingsRow } from "./settings-parts.js";

const DAY = 24 * 60 * 60 * 1000;
type Period = "7" | "30" | "90" | "365" | "Custom";
const PERIODS: readonly Period[] = ["7", "30", "90", "365", "Custom"];

/** The value a date input takes for a time, in the computer's own time zone. */
function localDate(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** When the history before a period starts. A date the user picks starts at that day's midnight. */
function startOf(period: Period, date: string): number {
  if (period !== "Custom") return Date.now() - Number(period) * DAY;
  const time = new Date(`${date}T00:00:00`).getTime();
  return Number.isFinite(time) ? time : Number.NaN;
}

function format(time: number, clock: boolean): string {
  return new Intl.DateTimeFormat(
    language,
    clock
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" },
  ).format(time);
}

/**
 * A month of days to pick the date the history is cleared before. Days after
 * `max` cannot be picked. Dates are `YYYY-MM-DD` in the computer's time zone.
 */
function DateCalendar({
  value,
  max,
  label,
  onChange,
}: {
  value: string;
  max: string;
  label: string;
  onChange: (date: string) => void;
}) {
  const [year, month] = value.split("-").map(Number) as [number, number];
  const [shown, setShown] = useState({ year, month: month - 1 });
  const first = new Date(shown.year, shown.month, 1);
  // Chinese calendars start on Monday, English ones on Sunday.
  const weekStart = language.startsWith("zh") ? 1 : 0;
  const lead = (first.getDay() - weekStart + 7) % 7;
  const days = new Date(shown.year, shown.month + 1, 0).getDate();
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(language, { weekday: "narrow" }).format(
      new Date(2024, 0, 7 + weekStart + index),
    ),
  );
  const today = localDate(Date.now());
  const maxMonth = max.slice(0, 7);
  const shownMonth = `${shown.year}-${String(shown.month + 1).padStart(2, "0")}`;
  const move = (step: number) =>
    setShown(({ year, month }) => {
      const next = new Date(year, month + step, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  return (
    <div
      className="project-file-history-calendar"
      role="group"
      aria-label={label}
    >
      <div className="project-file-history-calendar-header">
        <button
          type="button"
          aria-label={t("projectFileHistory.previousMonth")}
          onClick={() => move(-1)}
        >
          <ChevronLeft size="sm" />
        </button>
        <strong>
          {new Intl.DateTimeFormat(language, {
            year: "numeric",
            month: "long",
          }).format(first)}
        </strong>
        <button
          type="button"
          aria-label={t("projectFileHistory.nextMonth")}
          disabled={shownMonth >= maxMonth}
          onClick={() => move(1)}
        >
          <ChevronRight size="sm" />
        </button>
      </div>
      <div className="project-file-history-calendar-grid">
        {weekdays.map((day, index) => (
          <span
            key={`weekday-${index}`}
            className="project-file-history-calendar-weekday"
            aria-hidden="true"
          >
            {day}
          </span>
        ))}
        {Array.from({ length: lead }, (_, index) => (
          <span key={`lead-${index}`} />
        ))}
        {Array.from({ length: days }, (_, index) => {
          const date = `${shownMonth}-${String(index + 1).padStart(2, "0")}`;
          const classes = [
            date === value ? "is-selected" : "",
            date === today ? "is-today" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={date}
              type="button"
              className={classes}
              aria-pressed={date === value}
              aria-label={format(new Date(`${date}T00:00:00`).getTime(), false)}
              disabled={date > max}
              onClick={() => onChange(date)}
            >
              {index + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** As `formatBytes`, and in gigabytes from one: a project's file history often takes more than that. */
function size(value: number): string {
  const gigabyte = 1024 * 1024 * 1024;
  return value < gigabyte
    ? formatBytes(value)
    : `${(value / gigabyte).toFixed(1)} GB`;
}

/**
 * The file history of one project, which lets its turns be undone, with how
 * much disk it takes and a way to free the older part of it. Nothing of the
 * workspace or the conversations changes; the turns it takes can no longer be
 * undone.
 */
/** How a number of days to clear the history after reads: "7 days", "1 year". */
function periodLabel(days: number): string {
  return t(`projectFileHistory.period${days}` as "projectFileHistory.period7");
}

/**
 * The app setting to clear every project's file history after a number of
 * days. Turning it on, or shortening it, asks first: the turns of that time
 * lose their Undo.
 */
export function FileHistoryAutoClear() {
  const [days, setDays] = useState<number>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<number>();
  useEffect(() => {
    let disposed = false;
    void getFileHistorySettings()
      .then((value) => {
        if (disposed) return;
        setDays(value.autoClearDays);
        setError(value.problem);
      })
      .catch((cause) => {
        if (!disposed) setError(String(cause));
      });
    return () => {
      disposed = true;
    };
  }, []);
  async function save(value: number) {
    setSaving(true);
    try {
      setDays((await setFileHistorySettings(value)).autoClearDays);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
      setConfirm(undefined);
    }
  }
  function choose(value: number) {
    if (value && (!days || value < days)) setConfirm(value);
    else void save(value);
  }
  return (
    <>
      <SettingsRow
        title={t("projectFileHistory.autoClear")}
        description={t("projectFileHistory.autoClearHint")}
      >
        <Select
          size="sm"
          label={t("projectFileHistory.autoClear")}
          value={String(days ?? 0)}
          disabled={days === undefined || saving}
          onChange={(value) => choose(Number(value))}
          options={[
            { value: "0", label: t("projectFileHistory.autoClearOff") },
            ...[7, 30, 90, 365].map((value) => ({
              value: String(value),
              label: periodLabel(value),
            })),
          ]}
        />
      </SettingsRow>
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
      {confirm ? (
        <Dialog
          open
          size="sm"
          title={t("projectFileHistory.autoClearConfirmTitle", {
            period: periodLabel(confirm),
          })}
          description={t("projectFileHistory.autoClearConfirmDescription")}
          onClose={() => {
            if (!saving) setConfirm(undefined);
          }}
          footer={
            <>
              <Button disabled={saving} onClick={() => setConfirm(undefined)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={saving}
                onClick={() => void save(confirm)}
              >
                {t("projectFileHistory.autoClearConfirm")}
              </Button>
            </>
          }
        />
      ) : null}
    </>
  );
}

export function ProjectFileHistory({ project }: { project: ProjectState }) {
  // Undefined while the size is read, and negative when it could not be.
  const [bytes, setBytes] = useState<number>();
  // After how many days the app clears the history by itself, 0 when it does not.
  const [autoClearDays, setAutoClearDays] = useState(0);
  const [dialog, setDialog] = useState(false);
  // Changed after a clear, which frees some of what the history held: the size is read again.
  const [cleared, setCleared] = useState(0);
  useEffect(() => {
    let disposed = false;
    void getCheckpointHistory(project.id)
      .then(({ bytes }) => {
        if (!disposed) setBytes(bytes);
      })
      .catch(() => {
        if (!disposed) setBytes(-1);
      });
    return () => {
      disposed = true;
    };
  }, [project.id, cleared]);
  useEffect(() => {
    let disposed = false;
    void getFileHistorySettings()
      .then(({ autoClearDays }) => {
        if (!disposed) setAutoClearDays(autoClearDays);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
  const known = bytes !== undefined && bytes >= 0;
  return (
    <section
      className="project-appearance-row project-file-history"
      aria-label={t("projectFileHistory.title")}
    >
      <div className="project-appearance-copy">
        <strong>{t("projectFileHistory.title")}</strong>
        <span>
          {autoClearDays
            ? t("projectFileHistory.hintAuto", {
                period: periodLabel(autoClearDays),
              })
            : t("projectFileHistory.hint")}
        </span>
      </div>
      <span className="project-file-history-size">
        {bytes === undefined ? (
          <Spinner size={13} />
        ) : known ? (
          t("projectFileHistory.size", { size: size(bytes) })
        ) : (
          t("projectFileHistory.unavailableShort")
        )}
      </span>
      <Button
        size="sm"
        icon={<Trash2 size="sm" />}
        disabled={!known || bytes === 0}
        onClick={() => setDialog(true)}
      >
        {t("projectFileHistory.freeUp")}
      </Button>
      {dialog ? (
        <ClearHistoryDialog
          projectId={project.id}
          onCleared={() => setCleared((count) => count + 1)}
          onClose={() => setDialog(false)}
        />
      ) : null}
    </section>
  );
}

type Preview = { cutoff: number; result?: CheckpointHistory; failed?: boolean };

/**
 * Asks before the history goes. It says what the chosen time frees and how
 * many turns lose their Undo, which it reads first: the button stays off
 * until that is known, and when there is nothing to remove. Its height stays
 * the same whatever is chosen, so the dialog does not move: the figures read
 * last stay, dimmed, while the next ones are read, and a custom date is
 * picked in a popover.
 */
function ClearHistoryDialog({
  projectId,
  onCleared,
  onClose,
}: {
  projectId: string;
  onCleared: () => void;
  onClose: () => void;
}) {
  const today = localDate(Date.now());
  const [period, setPeriod] = useState<Period>("30");
  const [cutoff, setCutoff] = useState(() => startOf("30", ""));
  const [date, setDate] = useState(() => localDate(cutoff));
  const [picking, setPicking] = useState(false);
  const periods = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Preview>();
  // The figures last read, shown while those for a new choice are read.
  const [last, setLast] = useState<CheckpointHistory>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    setPreview({ cutoff });
    void getCheckpointHistory(projectId, cutoff)
      .then((result) => {
        if (disposed) return;
        setPreview({ cutoff, result });
        setLast(result);
      })
      .catch(() => {
        if (!disposed) setPreview({ cutoff, failed: true });
      });
    return () => {
      disposed = true;
    };
  }, [projectId, cutoff]);

  function choose(next: Period): void {
    setError(undefined);
    if (next === "Custom") {
      // Picking again opens the calendar again.
      setPicking(true);
      if (period !== "Custom") {
        setPeriod("Custom");
        setDate(localDate(cutoff));
        setCutoff(startOf("Custom", localDate(cutoff)));
      }
      return;
    }
    setPeriod(next);
    setCutoff(startOf(next, date));
  }

  // Only what was read for the time that is chosen now.
  const shown = preview?.cutoff === cutoff ? preview : undefined;
  const result = shown?.result;
  const figures = result ?? (shown?.failed ? undefined : last);
  const loading = !shown?.failed && !result;
  const removable = result?.removableBytes ?? 0;
  const nothing = result !== undefined && removable === 0;

  async function clear(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await clearCheckpointHistory(projectId, cutoff);
      onCleared();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (!busy) onClose();
  };
  const customLabel =
    period === "Custom"
      ? new Intl.DateTimeFormat(language, {
          month: "short",
          day: "numeric",
        }).format(cutoff)
      : t("projectFileHistory.periodCustom");
  return (
    <Dialog
      open
      size="sm"
      title={t("projectFileHistory.dialogTitle")}
      description={t("projectFileHistory.dialogDescription")}
      onClose={close}
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !result || nothing}
            onClick={() => void clear()}
          >
            {busy
              ? t("projectFileHistory.clearing")
              : nothing
                ? t("projectFileHistory.nothing")
                : result
                  ? t("projectFileHistory.clearSize", { size: size(removable) })
                  : t("projectFileHistory.clear")}
          </Button>
        </>
      }
    >
      <div className="project-file-history-dialog">
        <div className="project-file-history-period" ref={periods}>
          <span className="project-file-history-label">
            {t("projectFileHistory.period")}
          </span>
          <SegmentedControl<Period>
            size="sm"
            label={t("projectFileHistory.period")}
            value={period}
            onChange={choose}
            options={PERIODS.map((value) => ({
              value,
              label:
                value === "Custom"
                  ? customLabel
                  : t(`projectFileHistory.period${value}`),
            }))}
          />
        </div>
        <Popover
          open={picking}
          onClose={() => setPicking(false)}
          anchor={periods}
          placement="bottom-end"
          className="project-file-history-popover"
          label={t("projectFileHistory.customDate")}
        >
          <DateCalendar
            value={date}
            max={today}
            label={t("projectFileHistory.customDate")}
            onChange={(next) => {
              setDate(next);
              setCutoff(startOf("Custom", next));
              setPicking(false);
            }}
          />
        </Popover>
        <div
          className={`project-file-history-summary${loading && figures ? " is-loading" : ""}${nothing ? " is-empty" : ""}`}
          aria-live="polite"
          aria-busy={loading}
        >
          {loading ? (
            <span className="project-file-history-spinner">
              <Spinner size={12} />
            </span>
          ) : null}
          <div className="project-file-history-stats">
            <div className="project-file-history-stat">
              <strong>
                {figures ? size(figures.removableBytes ?? 0) : "—"}
              </strong>
              <span>{t("projectFileHistory.frees")}</span>
            </div>
            <div className="project-file-history-stat">
              <strong>{figures ? (figures.turns ?? 0) : "—"}</strong>
              <span>
                {t("projectFileHistory.turns", { count: figures?.turns ?? 0 })}
              </span>
            </div>
          </div>
          {shown?.failed || error ? (
            <p className="project-file-history-cutoff is-error" role="alert">
              {error ?? t("projectFileHistory.unavailable")}
            </p>
          ) : (
            <p className="project-file-history-cutoff">
              <Clock size="sm" aria-hidden="true" />
              <span>
                {t("projectFileHistory.before", {
                  date: format(cutoff, period !== "Custom"),
                })}
              </span>
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
