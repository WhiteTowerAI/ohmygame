import { ClipboardList, X } from "./icons.js";
import { t } from "./i18n.js";

interface PlanModeIndicatorProps {
  disabled?: boolean;
  onExit: () => void;
}

/** Plan mode while it is on: a chip beside the + button, closed with its ×. */
export function PlanModeIndicator({ disabled, onExit }: PlanModeIndicatorProps) {
  return (
    <span className="composer-plan-mode" aria-label={t("planMode.active")}>
      <ClipboardList size={13} aria-hidden="true" />
      {t("planMode.mode")}
      <button type="button" disabled={disabled} onClick={onExit} title={t("planMode.exit")} aria-label={t("planMode.exit")}>
        <X size={11} aria-hidden="true" />
      </button>
    </span>
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
