import { Check, ChevronDown, Circle, CircleDot } from "./icons.js";
import type { PlanState } from "../shared/contracts.js";
import { t } from "./i18n.js";

interface PlanStatusProps {
  plan?: PlanState;
}

export function PlanStatus({ plan }: PlanStatusProps) {
  if (!plan?.steps.length) return null;
  const currentIndex = currentStepIndex(plan);
  const current = plan.steps[currentIndex];
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const summary = current
    ? t("planStatus.step", { current: currentIndex + 1, total: plan.steps.length, step: current.step })
    : t("planStatus.completed", { completed, total: plan.steps.length });

  return (
    <div className="plan-status">
      <div className="plan-status-summary" tabIndex={0}>
        {completed === plan.steps.length ? <Check size={13} aria-hidden="true" /> : <CircleDot size={13} aria-hidden="true" />}
        <span>{summary}</span>
        <ChevronDown className="plan-status-chevron" size={13} aria-hidden="true" />
      </div>
      <div className="plan-status-details">
        {plan.explanation ? <p>{plan.explanation}</p> : null}
        <ol>
          {plan.steps.map((step, index) => (
            <li className={`plan-status-step plan-${step.status}`} key={`${index}:${step.step}`}>
              {step.status === "completed" ? <Check size={13} /> : step.status === "in_progress" ? <CircleDot size={13} /> : <Circle size={13} />}
              <span>{step.step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function currentStepIndex(plan: PlanState): number {
  const inProgress = plan.steps.findIndex((step) => step.status === "in_progress");
  return inProgress >= 0 ? inProgress : plan.steps.findIndex((step) => step.status === "pending");
}
