import { useEffect, useState } from "react";
import type { AgentModelRef } from "../shared/contracts.js";
import {
  ORCHESTRATOR_MAX_ROLES,
  ORCHESTRATOR_ROLE_ID_PATTERN,
  type OrchestratorRoleCapability,
  type OrchestratorRoleConfig,
  type OrchestratorState,
} from "../shared/orchestrator.js";
import { removeOrchestrator, saveOrchestrator, startOrchestrator, stopOrchestrator } from "./api.js";
import { t } from "./i18n.js";
import { CircleStop, LoaderCircle, Play, Plus, Trash2 } from "./icons.js";
import { Alert, Badge, Button, Field, IconButton, Input, Select, Textarea } from "./ui/index.js";
import "./orchestrator-panel.css";

/** One role speaking to another, as the project's event stream reported it. */
export interface TeamMessage {
  id: number;
  fromRoleId: string;
  toRoleId: string;
  text: string;
}

interface Draft {
  goal: string;
  roles: OrchestratorRoleConfig[];
}

// Personas go to the model, so they stay in English whatever the interface language.
const STARTER_ROLES: ReadonlyArray<Omit<OrchestratorRoleConfig, "model">> = [
  { id: "programmer", name: "Programmer", capability: "writer", persona: "You build the game. You write and change the project's files, run its checks, and ask the critic for feedback when a change is ready to try." },
  { id: "critic", name: "Critic", capability: "advisor", persona: "You judge how the game plays and reads. Read the project, point out the most important problem with a concrete suggestion, and keep feedback short." },
];

/** A stable id for a role from its name, unique within the roster. */
function roleId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 32) || "role";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function draftFrom(state: OrchestratorState | undefined, model: AgentModelRef | undefined): Draft {
  if (state?.config.roles.length) return { goal: state.config.goal, roles: state.config.roles };
  return { goal: "", roles: model ? STARTER_ROLES.map((role) => ({ ...role, model })) : [] };
}

function problem(draft: Draft): string | undefined {
  if (!draft.goal.trim()) return t("team.needGoal");
  if (!draft.roles.some((role) => role.capability === "writer")) return t("team.needWriter");
  if (draft.roles.some((role) => !role.name.trim() || !role.persona.trim())) return t("team.needRoleText");
  return undefined;
}

export function OrchestratorPanel({
  projectId,
  state,
  messages,
  defaultModel,
  onState,
  onOpenConversation,
}: {
  projectId: string;
  state: OrchestratorState | undefined;
  messages: readonly TeamMessage[];
  /** The model a new role uses: the current conversation's. */
  defaultModel: AgentModelRef | undefined;
  onState: (state: OrchestratorState | undefined) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const running = state?.status === "running";
  const [editing, setEditing] = useState(!state?.config.roles.length);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(state, defaultModel));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const unreadable = state?.diagnostic?.code === "store-unreadable";

  useEffect(() => {
    if (running) setEditing(false);
  }, [running]);

  const act = async (work: () => Promise<OrchestratorState | undefined>) => {
    setBusy(true);
    setError(undefined);
    try {
      onState(await work());
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id: string) => state?.roles.find((role) => role.config.id === id)?.config.name ?? id;

  if (editing && !unreadable) {
    const invalid = problem(draft);
    const setRole = (index: number, change: Partial<OrchestratorRoleConfig>) =>
      setDraft((current) => ({ ...current, roles: current.roles.map((role, at) => (at === index ? { ...role, ...change } : role)) }));
    const capabilities = [
      { value: "writer" as const, label: t("team.writer"), description: t("team.writerHint") },
      { value: "advisor" as const, label: t("team.advisor"), description: t("team.advisorHint") },
    ];
    return (
      <div className="team-panel">
        <Field label={t("team.goal")} hint={t("team.goalHint")}>
          {(field) => <Textarea {...field} value={draft.goal} rows={3} maxLength={4_000} placeholder={t("team.goalPlaceholder")}
            onChange={(event) => setDraft((current) => ({ ...current, goal: event.target.value }))} />}
        </Field>
        <div className="team-roles">
          {draft.roles.map((role, index) => (
            <div className="team-role-editor" key={index}>
              <div className="team-role-editor-row">
                <Input aria-label={t("team.roleName")} value={role.name} maxLength={80} placeholder={t("team.roleName")}
                  onChange={(event) => setRole(index, { name: event.target.value })} />
                <Select<OrchestratorRoleCapability> label={t("team.capability")} value={role.capability} options={capabilities}
                  onChange={(capability) => setRole(index, { capability })} />
                <IconButton label={t("team.removeRole")} disabled={draft.roles.length <= 1}
                  onClick={() => setDraft((current) => ({ ...current, roles: current.roles.filter((_, at) => at !== index) }))}>
                  <Trash2 size={14} />
                </IconButton>
              </div>
              <Textarea aria-label={t("team.persona")} value={role.persona} rows={2} maxLength={4_000} placeholder={t("team.personaPlaceholder")}
                onChange={(event) => setRole(index, { persona: event.target.value })} />
            </div>
          ))}
        </div>
        {!defaultModel ? <Alert tone="info" title={t("team.needModel")} /> : null}
        <div className="team-actions">
          <Button size="sm" icon={<Plus size={14} />} disabled={!defaultModel || draft.roles.length >= ORCHESTRATOR_MAX_ROLES}
            onClick={() => setDraft((current) => ({
              ...current,
              roles: [...current.roles, { id: "", name: "", persona: "", capability: "advisor", model: defaultModel! }],
            }))}>
            {t("team.addRole")}
          </Button>
          <span className="team-spacer" />
          {state?.config.roles.length ? <Button size="sm" variant="ghost" onClick={() => { setDraft(draftFrom(state, defaultModel)); setEditing(false); }}>{t("team.cancel")}</Button> : null}
          <Button size="sm" variant="primary" disabled={busy || Boolean(invalid)} title={invalid}
            onClick={async () => {
              // A role keeps its id once saved, so its conversation carries on; a new role takes one from its name.
              const taken = new Set<string>();
              const roles = draft.roles.map((role) => {
                const id = ORCHESTRATOR_ROLE_ID_PATTERN.test(role.id) && !taken.has(role.id) ? role.id : roleId(role.name, taken);
                taken.add(id);
                return { ...role, id, name: role.name.trim(), persona: role.persona.trim() };
              });
              if (await act(() => saveOrchestrator(projectId, { goal: draft.goal.trim(), roles }))) setEditing(false);
            }}>
            {t("team.save")}
          </Button>
        </div>
        {error ? <Alert tone="danger" title={error} /> : null}
      </div>
    );
  }

  if (!state) return null;
  return (
    <div className="team-panel">
      <div className="team-goal">
        <span className="team-label">{t("team.goal")}</span>
        <p>{state.config.goal}</p>
      </div>
      {state.diagnostic ? <Alert tone="danger" title={state.diagnostic.code === "ping-pong" ? t("team.pausedTitle") : t("team.unreadableTitle")}>{state.diagnostic.message}</Alert> : null}
      {state.status === "completed" ? <Alert tone="success" title={t("team.completedTitle")}>{state.summary}</Alert> : null}
      <ul className="team-roster">
        {state.roles.map((role) => (
          <li key={role.config.id} className="team-role">
            <span className={`team-dot team-dot-${role.status}`} aria-label={t(`team.status.${role.status}`)} title={t(`team.status.${role.status}`)} />
            <span className="team-role-name">{role.config.name}</span>
            <Badge tone={role.config.capability === "writer" ? "ink" : "outline"}>{role.config.capability === "writer" ? t("team.writer") : t("team.advisor")}</Badge>
            <span className="team-spacer" />
            {role.conversationId ? <Button size="sm" variant="ghost" onClick={() => onOpenConversation(role.conversationId!)}>{t("team.open")}</Button> : null}
          </li>
        ))}
      </ul>
      <div className="team-actions">
        <span className="team-status">{t(`team.run.${state.status}`)}</span>
        <span className="team-spacer" />
        {!running && !unreadable ? <>
          <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={busy}
            onClick={() => void act(async () => { await removeOrchestrator(projectId); setDraft(draftFrom(undefined, defaultModel)); setEditing(true); return undefined; })}>
            {t("team.disband")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(draftFrom(state, defaultModel)); setEditing(true); }}>{t("team.edit")}</Button>
        </> : null}
        {running
          ? <Button size="sm" variant="primary" icon={busy ? <LoaderCircle className="spin" size={14} /> : <CircleStop size={14} />} disabled={busy}
            onClick={() => void act(() => stopOrchestrator(projectId))}>{t("team.stop")}</Button>
          : unreadable ? null : <Button size="sm" variant="primary" icon={busy ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} disabled={busy}
            onClick={() => void act(() => startOrchestrator(projectId))}>{t("team.start")}</Button>}
      </div>
      {error ? <Alert tone="danger" title={error} /> : null}
      <div className="team-messages" aria-live="polite">
        <span className="team-label">{t("team.messages")}</span>
        {messages.length
          ? <ol>{messages.map((message) => (
            <li key={message.id}>
              <span className="team-message-route">{t("team.messageRoute", { from: nameOf(message.fromRoleId), to: nameOf(message.toRoleId) })}</span>
              <span className="team-message-text">{message.text}</span>
            </li>
          ))}</ol>
          : <p className="team-empty">{t("team.noMessages")}</p>}
      </div>
    </div>
  );
}
