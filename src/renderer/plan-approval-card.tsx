import { ArrowRight, X } from "lucide-react";
import { useState } from "react";
import { InlineAnswer } from "./inline-answer.js";

interface PlanApprovalCardProps {
  disabled?: boolean;
  onApprove: () => Promise<boolean>;
  onRefine: (feedback: string) => Promise<boolean>;
  onCancel: () => Promise<boolean>;
}

export function PlanApprovalCard({ disabled, onApprove, onRefine, onCancel }: PlanApprovalCardProps) {
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function run(action: () => Promise<boolean>) {
    if (disabled || submitting) return;
    setSubmitting(true);
    try {
      await action();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="plan-approval-card" aria-label="Plan approval">
      <header>
        <strong>Implement this plan?</strong>
        <button type="button" disabled={disabled || submitting} onClick={() => void run(onCancel)} aria-label="Cancel plan"><X size={15} /></button>
      </header>

      <button className="plan-approval-approve" type="button" disabled={disabled || submitting} onClick={() => void run(onApprove)}>
        <span>1</span>
        <strong>Yes, implement this plan</strong>
        <ArrowRight size={15} />
      </button>

      {editing ? (
        <InlineAnswer
          editing
          value={feedback}
          disabled={disabled || submitting}
          label="No, and tell OpenGame what to do differently"
          placeholder="Tell OpenGame what to do differently"
          onChange={setFeedback}
          onSubmit={() => void run(() => onRefine(feedback.trim()))}
          onCancel={() => { setEditing(false); setFeedback(""); }}
        />
      ) : (
        <div className="plan-approval-footer">
          <InlineAnswer
            editing={false}
            disabled={disabled || submitting}
            label="No, and tell OpenGame what to do differently"
            onEdit={() => setEditing(true)}
          />
          <button className="plan-approval-skip" type="button" disabled={disabled || submitting} onClick={() => void run(onCancel)}>Skip</button>
        </div>
      )}
    </section>
  );
}
