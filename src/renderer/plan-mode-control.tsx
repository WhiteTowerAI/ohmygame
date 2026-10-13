import { CircleX, FileText, Lightbulb } from "./icons.js";
import { t } from "./i18n.js";

interface PlanModeIndicatorProps {
  disabled?: boolean;
  onExit: () => void;
}

export function PlanModeIndicator({ disabled, onExit }: PlanModeIndicatorProps) {
  return (
    <div className="composer-plan-mode" aria-label={t("planMode.active")}>
      <button type="button" disabled={disabled} onClick={onExit} title={t("planMode.exit")} aria-label={t("planMode.exit")}>
        <Lightbulb className="composer-plan-icon" size={15} aria-hidden="true" />
        <CircleX className="composer-plan-close" size={15} aria-hidden="true" />
        <span>{t("planMode.plan")}</span>
      </button>
    </div>
  );
}

interface PlanCommandMenuProps {
  planning: boolean;
  onToggle: () => void;
  showPlan?: boolean;
  showCompact?: boolean;
  onCompact?: () => void;
  selected?: "plan" | "compact";
  contextPercent?: number;
}

export function PlanCommandMenu({ planning, onToggle, showPlan = true, showCompact = false, onCompact, selected, contextPercent }: PlanCommandMenuProps) {
  return (
    <div className="composer-command-menu" role="listbox" aria-label={t("planMode.commands")}>
      {showPlan ? <button className={selected === "plan" ? "is-selected" : ""} type="button" role="option" aria-selected={selected === "plan"} onClick={onToggle}>
        <Lightbulb size={15} aria-hidden="true" />
        <span>{t("planMode.mode")}</span>
        <small>{planning ? t("planMode.turnOff") : t("planMode.turnOn")}</small>
      </button> : null}
      {showCompact ? <button className={selected === "compact" ? "is-selected" : ""} type="button" role="option" aria-selected={selected === "compact"} onClick={onCompact}>
        <FileText size={15} aria-hidden="true" />
        <span>{t("planMode.compact")}</span>
        <small>{t("planMode.compactHint")}{contextPercent === undefined ? "" : t("planMode.full", { percent: contextPercent })}</small>
      </button> : null}
    </div>
  );
}

export function matchesPlanCommand(value: string): boolean {
  const command = value.trim().toLowerCase();
  return command.startsWith("/") && !command.includes(" ") && "/plan".startsWith(command);
}

export function matchesCompactCommand(value: string): boolean {
  const command = value.trim().toLowerCase();
  return (command.startsWith("/") && !command.includes(" ") && "/compact".startsWith(command)) || command.startsWith("/compact ");
}

export function compactInstructions(value: string): string | undefined | null {
  const command = value.trim();
  if (command.toLowerCase() === "/compact") return undefined;
  if (command.toLowerCase().startsWith("/compact ")) return command.slice(9).trim() || undefined;
  return null;
}
