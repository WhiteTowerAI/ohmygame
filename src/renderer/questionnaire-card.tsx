import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { QuestionnaireRequest } from "../shared/contracts.js";
import { InlineAnswer } from "./inline-answer.js";

interface QuestionnaireCardProps {
  request: QuestionnaireRequest;
  onSubmit: (answers: Array<{ questionId: string; value: string }>) => Promise<boolean>;
  onSkip: () => Promise<boolean>;
}

export function QuestionnaireCard({ request, onSubmit, onSkip }: QuestionnaireCardProps) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const question = request.questions[index];

  useEffect(() => {
    setIndex(0);
    setAnswers({});
    setCustom(false);
  }, [request.id]);

  if (!question) return null;
  const answer = answers[question.id] ?? "";
  const selectedOption = question.options.some((option) => option.value === answer);
  async function choose(value: string) {
    const nextAnswers = { ...answers, [question.id]: value };
    setAnswers(nextAnswers);
    setCustom(false);
    const unanswered = request.questions.findIndex((item, itemIndex) => itemIndex > index && !nextAnswers[item.id]?.trim());
    const remaining = unanswered >= 0 ? unanswered : request.questions.findIndex((item) => !nextAnswers[item.id]?.trim());
    if (remaining >= 0) {
      setIndex(remaining);
      return;
    }
    await submit(nextAnswers);
  }

  function move(next: number) {
    setIndex(Math.max(0, Math.min(request.questions.length - 1, next)));
    setCustom(false);
  }

  async function submit(nextAnswers: Record<string, string>) {
    if (submitting || !request.questions.every((item) => Boolean(nextAnswers[item.id]?.trim()))) return;
    setSubmitting(true);
    try {
      await onSubmit(request.questions.map((item) => ({ questionId: item.id, value: nextAnswers[item.id] })));
    } finally {
      setSubmitting(false);
    }
  }

  async function skip() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSkip();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="questionnaire-card" aria-label="Planning questions">
      <header>
        <strong>{question.prompt}</strong>
        <div className="questionnaire-navigation">
          <button type="button" onClick={() => move(index - 1)} disabled={submitting || index === 0} aria-label="Previous question"><ArrowLeft size={14} /></button>
          <span>{index + 1} of {request.questions.length}</span>
          <button type="button" onClick={() => move(index + 1)} disabled={submitting || index === request.questions.length - 1} aria-label="Next question"><ArrowRight size={14} /></button>
          <button type="button" onClick={() => void skip()} disabled={submitting} aria-label="Skip questions"><X size={15} /></button>
        </div>
      </header>

      <div className="questionnaire-options">
        {question.options.map((option, optionIndex) => (
          <button
            type="button"
            className={answer === option.value ? "questionnaire-option-selected" : undefined}
            disabled={submitting}
            key={option.value}
            onClick={() => { void choose(option.value); }}
          >
            <span className="questionnaire-option-number">{answer === option.value ? <Check size={13} /> : optionIndex + 1}</span>
            <span className="questionnaire-option-copy">
              <strong>{option.label}{option.recommended ? <small>Recommended</small> : null}</strong>
              {option.description ? <span>{option.description}</span> : null}
            </span>
          </button>
        ))}
      </div>

      <footer className="questionnaire-footer-row">
        {question.allowOther ? custom ? (
          <InlineAnswer
            editing
            value={selectedOption ? "" : answer}
            disabled={submitting}
            label="Type another answer"
            onChange={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))}
            onSubmit={() => void choose(answer.trim())}
            onCancel={() => setCustom(false)}
          />
        ) : (
          <InlineAnswer
            editing={false}
            disabled={submitting}
            label="Type another answer"
            onEdit={() => { setAnswers((current) => ({ ...current, [question.id]: "" })); setCustom(true); }}
          />
        ) : <span />}
        <button className="questionnaire-skip" type="button" onClick={() => void skip()} disabled={submitting}>Skip</button>
      </footer>
    </section>
  );
}
