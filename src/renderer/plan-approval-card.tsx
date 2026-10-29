import { useState } from "react";
import { InlineAnswer } from "./inline-answer.js";
import { Button } from "./ui/index.js";
import { t } from "./i18n.js";

interface PlanApprovalCardProps {
  disabled?: boolean;
  onApprove: () => Promise<boolean>;
  onRefine: (feedback: string) => Promise<boolean>;
  onCancel: () => Promise<boolean>;
}

/** The plan waits here to be approved and run, revised with feedback, or cancelled. */
export function PlanApprovalCard({ disabled, onApprove, onRefine, onCancel }: PlanApprovalCardProps) {
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const busy = disabled || submitting;

  async function run(action: () => Promise<boolean>) {
    if (busy) return;
    setSubmitting(true);
    try {
      await action();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="plan-approval-card" aria-label={t("planApproval.label")}>
      <header>
        <span className="chat-card-kind">{t("planApproval.kind")}</span>
        <strong>{t("planApproval.title")}</strong>
      </header>

      {editing ? (
        <InlineAnswer
          editing
          value={feedback}
          disabled={busy}
          label={t("planApproval.refine")}
          placeholder={t("planApproval.refinePlaceholder")}
          onChange={setFeedback}
          onSubmit={() => void run(() => onRefine(feedback.trim()))}
          onCancel={() => { setEditing(false); setFeedback(""); }}
        />
      ) : null}

      <footer>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(onApprove)}>{t("planApproval.approve")}</Button>
        {editing ? null : <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>{t("planApproval.refine")}</Button>}
        <Button size="sm" variant="ghost" className="plan-approval-cancel" disabled={busy} onClick={() => void run(onCancel)}>{t("planApproval.cancel")}</Button>
      </footer>
    </section>
  );
}
