import { useEffect, useState } from "react";
import { USER_INSTRUCTIONS_MAX_CHARACTERS, type AgentInstructionsView } from "../shared/agent-instructions.js";
import type { ProjectType } from "../shared/contracts.js";
import { getAgentInstructions, setAgentInstructions } from "./api.js";
import { LoaderCircle } from "./icons.js";
import { SettingsDetailHead, SettingsGroup, SettingsNote } from "./settings-parts.js";
import { Button, CodeBlock, Tabs, Textarea } from "./ui/index.js";
import { t } from "./i18n.js";

/** Settings › Agents › Instructions: the page's id among the agents. */
export const AGENT_INSTRUCTIONS = "instructions";

function typeLabel(type: ProjectType): string {
  return type === "plugin" ? t("settings.agents.instructions.pluginBuilder") : t(`projectType.${type}`);
}

/**
 * What the agent is told: the person's own instructions, which go to every
 * agent in every project, and OhMyGame's, shown as they are for each kind of
 * project so nothing the agent hears from OhMyGame is hidden.
 */
export function AgentInstructionsSettings({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<AgentInstructionsView>();
  const [draft, setDraft] = useState("");
  const [type, setType] = useState<ProjectType>("web-game");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    getAgentInstructions()
      .then((loaded) => { if (active) { setView(loaded); setDraft(loaded.custom); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const next = await setAgentInstructions(draft);
      setView(next);
      setDraft(next.custom);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const length = draft.trim().length;
  const tooLong = length > USER_INSTRUCTIONS_MAX_CHARACTERS;
  const changed = view !== undefined && draft.trim() !== view.custom;
  const builtIn = view?.builtIn.find((entry) => entry.type === type) ?? view?.builtIn[0];

  return (
    <>
      <SettingsDetailHead title={t("settings.agents.instructions.title")} description={t("settings.agents.instructions.description")} onBack={onBack} backLabel={t("settings.agents.back")} />
      {!view && !error ? <div className="settings-loading-row"><LoaderCircle className="spin" size={16} />{t("common.loading")}</div> : null}
      {error && !view ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
      {view ? <>
        <SettingsGroup title={t("settings.agents.instructions.mine")} description={t("settings.agents.instructions.mineHint")} bare>
          <div className="agent-instructions-editor">
            {view.problem ? <SettingsNote tone="danger">{t("settings.agents.instructions.unreadable", { problem: view.problem })}</SettingsNote> : null}
            <Textarea
              value={draft}
              rows={8}
              disabled={Boolean(view.problem) || saving}
              placeholder={t("settings.agents.instructions.placeholder")}
              aria-label={t("settings.agents.instructions.mine")}
              onChange={(event) => { setDraft(event.target.value); setSaved(false); }}
            />
            <div className="agent-instructions-actions">
              <span className={`agent-instructions-count${tooLong ? " is-over" : ""}`}>
                {t("settings.agents.instructions.count", { count: length, max: USER_INSTRUCTIONS_MAX_CHARACTERS })}
              </span>
              {saved && !changed ? <span className="agent-instructions-saved" role="status">{t("settings.agents.instructions.saved")}</span> : null}
              <Button size="sm" variant="primary" disabled={!changed || tooLong || saving || Boolean(view.problem)} onClick={() => void save()}>
                {saving ? <LoaderCircle className="spin" size={14} /> : null}{t("common.save")}
              </Button>
            </div>
            {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
          </div>
        </SettingsGroup>
        <SettingsGroup title={t("settings.agents.instructions.builtIn")} description={t("settings.agents.instructions.builtInHint")} bare>
          <div className="agent-instructions-built-in">
            <Tabs
              label={t("settings.agents.instructions.builtIn")}
              variant="pills"
              value={builtIn?.type ?? type}
              tabs={view.builtIn.map((entry) => ({ value: entry.type, label: typeLabel(entry.type) }))}
              onChange={setType}
            />
            {builtIn ? <CodeBlock title={typeLabel(builtIn.type)} code={builtIn.text} /> : null}
            <p className="settings-detail-hint">{t("settings.agents.instructions.fullHint")}</p>
          </div>
        </SettingsGroup>
      </> : null}
    </>
  );
}
