import { CircleX, Lightbulb } from "./icons.js";
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
