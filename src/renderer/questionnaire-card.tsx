import { ArrowLeft, ArrowRight, Check } from "./icons.js";
import { useEffect, useRef, useState } from "react";
import type { QuestionnaireResponse, ThreadItem } from "../shared/contracts.js";
import { Button, Input } from "./ui/index.js";
import { t } from "./i18n.js";

type Request = Extract<ThreadItem, { type: "userInputRequest" }>;
interface QuestionnaireCardProps {
  request: Request;
  onSubmit: (answers: QuestionnaireResponse[]) => Promise<boolean>;
  onSkip: () => Promise<boolean>;
  onInteract: () => Promise<boolean>;
}
interface Draft {
  index: number;
  choices: Record<string, string[]>;
  text: Record<string, string>;
  custom: Record<string, boolean>;
}
// Drafts belong to requests, not the visible chat. Bounded and memory-only; never credentials.
const drafts = new Map<string, Draft>();
const emptyDraft = (): Draft => ({ index: 0, choices: {}, text: {}, custom: {} });

export function QuestionnaireCard(props: QuestionnaireCardProps) {
  return <Questions key={props.request.id} {...props} />;
}

function Questions({ request, onSubmit, onSkip, onInteract }: QuestionnaireCardProps) {
  const [draft, setDraft] = useState(() => drafts.get(request.id) ?? emptyDraft());
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const hold = useRef<Promise<boolean> | undefined>(undefined);
  const [held, setHeld] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!request.autoAnswerAt || held) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [request.autoAnswerAt, held]);
  const question = request.questions[draft.index];
  if (!question) return null;

  function interact(): Promise<boolean> {
    if (request.autoAnswerAt === undefined) return Promise.resolve(true);
    if (!hold.current) {
      hold.current = onInteract().then((ok) => {
        if (ok) setHeld(true);
        else hold.current = undefined;
        return ok;
      });
    }
    return hold.current;
  }
  function update(next: Draft) {
    void interact();
    drafts.delete(request.id);
    drafts.set(request.id, next);
    if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
    setDraft(next);
  }
  function values(id: string): string[] {
    const q = request.questions.find((item) => item.id === id)!;
    const custom = draft.custom[id] || !q.options.length;
    const text = draft.text[id]?.trim();
    return custom ? [...(q.multiSelect ? draft.choices[id] ?? [] : []), ...(text ? [text] : [])] : draft.choices[id] ?? [];
  }
  async function submit(skip = false) {
    if (busy.current || (!skip && request.questions.some((item) => !values(item.id).length))) return;
    busy.current = true;
    setSubmitting(true);
    try {
      if (!await interact()) return;
      const ok = skip ? await onSkip() : await onSubmit(request.questions.map((item) => ({
        questionId: item.id, value: values(item.id).join(", "),
        ...(item.multiSelect ? { values: values(item.id) } : {}),
      })));
      if (ok) drafts.delete(request.id);
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }
  const selected = draft.choices[question.id] ?? [];
  const custom = draft.custom[question.id] || !question.options.length;
  const last = draft.index === request.questions.length - 1;
  return (
    <section className="questionnaire-card" aria-label={t("questionnaire.label")}
      onPointerDownCapture={() => void interact()} onKeyDownCapture={() => void interact()}>
      <header>
        <div className="questionnaire-title">
          <span className="chat-card-kind">{t("questionnaire.kind")}</span>
          <strong>{question.prompt}</strong>
        </div>
        <div className="questionnaire-navigation">
          <button type="button" disabled={submitting || draft.index === 0} aria-label={t("questionnaire.previous")} onClick={() => update({ ...draft, index: draft.index - 1 })}><ArrowLeft size={14} /></button>
          <span>{t("questionnaire.position", { current: draft.index + 1, total: request.questions.length })}</span>
          <button type="button" disabled={submitting || last} aria-label={t("questionnaire.next")} onClick={() => update({ ...draft, index: draft.index + 1 })}><ArrowRight size={14} /></button>
        </div>
      </header>
      {question.multiSelect ? <span className="questionnaire-hint">{t("questionnaire.multiple")}</span> : null}
      <div className="questionnaire-options">
        {question.options.map((option) => {
          const checked = (!custom || question.multiSelect) && selected.includes(option.value);
          return <button type="button" key={option.value} aria-pressed={checked} disabled={submitting}
            className={checked ? "questionnaire-option-selected" : undefined}
            onClick={() => update({ ...draft, custom: { ...draft.custom, [question.id]: question.multiSelect ? !!draft.custom[question.id] : false }, choices: {
              ...draft.choices, [question.id]: question.multiSelect
                ? (selected.includes(option.value) ? selected.filter((value) => value !== option.value) : [...selected, option.value])
                : [option.value],
            } })}>
            <span className="questionnaire-option-number">{checked ? <Check size={13} /> : null}</span>
            <span className="questionnaire-option-copy">
              <strong>{option.label}{option.recommended ? <small>{t("providers.recommended")}</small> : null}</strong>
              {option.description ? <span>{option.description}</span> : null}
            </span>
          </button>;
        })}
      </div>
      {question.allowOther ? custom ? <Input className="questionnaire-text" size="sm" aria-label={question.options.length ? t("questionnaire.other") : question.prompt}
        placeholder={t("questionnaire.typeAnswer")} disabled={submitting} maxLength={2000}
        value={draft.text[question.id] ?? ""}
        onChange={(event) => update({ ...draft, text: { ...draft.text, [question.id]: event.target.value } })} />
        : <Button variant="ghost" size="sm" className="questionnaire-other" disabled={submitting} onClick={() => update({ ...draft, custom: { ...draft.custom, [question.id]: true } })}>{t("questionnaire.other")}</Button> : null}
      {request.autoAnswerAt && !held ? <div className="questionnaire-auto">
        <span role="timer">{t("questionnaire.countdown", { seconds: Math.max(0, Math.ceil((request.autoAnswerAt - now) / 1000)) })}</span>
        <Button variant="ghost" size="sm" onClick={() => void interact()}>{t("questionnaire.answerManually")}</Button>
      </div> : null}
      <footer>
        <button type="button" className="questionnaire-skip" disabled={submitting} onClick={() => void submit(true)}>{t("common.skip")}</button>
        <Button size="sm" disabled={submitting || (last ? request.questions.some((item) => !values(item.id).length) : !values(question.id).length)}
          onClick={() => last ? void submit() : update({ ...draft, index: draft.index + 1 })}>
          {last ? t("questionnaire.submitAll") : t("questionnaire.next")}
        </Button>
      </footer>
    </section>
  );
}
