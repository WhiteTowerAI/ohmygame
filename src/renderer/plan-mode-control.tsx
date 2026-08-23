import { CircleX, Lightbulb } from "lucide-react";

interface PlanModeIndicatorProps {
  disabled?: boolean;
  onExit: () => void;
}

export function PlanModeIndicator({ disabled, onExit }: PlanModeIndicatorProps) {
  return (
    <div className="composer-plan-mode" aria-label="Plan mode active">
      <button type="button" disabled={disabled} onClick={onExit} title="Exit plan mode" aria-label="Exit plan mode">
        <Lightbulb className="composer-plan-icon" size={15} aria-hidden="true" />
        <CircleX className="composer-plan-close" size={15} aria-hidden="true" />
        <span>Plan</span>
      </button>
    </div>
  );
}

interface PlanCommandMenuProps {
  planning: boolean;
  onToggle: () => void;
}

export function PlanCommandMenu({ planning, onToggle }: PlanCommandMenuProps) {
  return (
    <div className="composer-command-menu" role="listbox" aria-label="Composer commands">
      <button type="button" role="option" aria-selected="true" onClick={onToggle}>
        <Lightbulb size={15} aria-hidden="true" />
        <span>Plan mode</span>
        <small>{planning ? "Turn plan mode off" : "Turn plan mode on"}</small>
      </button>
    </div>
  );
}

export function matchesPlanCommand(value: string): boolean {
  const command = value.trim().toLowerCase();
  return command.startsWith("/") && !command.includes(" ") && "/plan".startsWith(command);
}
