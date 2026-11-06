import { useState } from "react";
import { ChevronRight, RefreshCw } from "./icons.js";
import { isAgentRuntimeId } from "../shared/agent-runtimes.js";
import { listAgentRuntimes, notifyAgentModelsChanged } from "./api.js";
import { CodingAgentDetail, CodingAgentsGroup } from "./coding-agents-settings.js";
import { useAgentModels } from "./model-selector.js";
import type { SettingsSection } from "./routes.js";
import { Badge, Button, IconButton } from "./ui/index.js";
import { SettingsDetailHead, SettingsGroup, SettingsNote, SettingsRow } from "./settings-parts.js";
import { t } from "./i18n.js";
import { BrandLogo } from "./brand-logo.js";

/** OhMyGame's own agent has a page like the coding agents do. */
export const OHMYGAME_AGENT = "ohmygame";

/**
 * Who does the work in a conversation: OhMyGame's own agent, which uses the
 * models set up in Providers, and the coding agent CLIs on this computer,
 * which bring their own models and accounts. Each opens its own page
 * (`#/settings/agents/<id>`); a conversation picks one in its model picker.
 */
export function AgentsSettings({
  agent,
  onOpen,
  onBack,
  onOpenSection,
  onOpenPlugins,
}: {
  agent?: string;
  onOpen: (id: string) => void;
  onBack: () => void;
  onOpenSection: (section: SettingsSection) => void;
  onOpenPlugins: () => void;
}) {
  if (agent === OHMYGAME_AGENT)
    return <OhMyGameAgent onBack={onBack} onOpenSection={onOpenSection} onOpenPlugins={onOpenPlugins} />;
  if (agent && isAgentRuntimeId(agent))
    return <CodingAgentDetail key={agent} id={agent} onBack={onBack} />;
  if (agent)
    return (
      <>
        <SettingsDetailHead title={t("settings.agents.notFound")} onBack={onBack} backLabel={t("settings.agents.back")} />
        <div><Button onClick={onBack}>{t("settings.agents.back")}</Button></div>
      </>
    );
  return <AgentList onOpen={onOpen} />;
}

function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <span className="settings-mark is-brand" aria-hidden="true">
      <BrandLogo size={size} />
    </span>
  );
}

function AgentList({ onOpen }: { onOpen: (id: string) => void }) {
  const catalog = useAgentModels({ agentRuntimes: true });
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string>();
  async function rescan(): Promise<void> {
    setRescanning(true);
    setError(undefined);
    try {
      await listAgentRuntimes(true);
      notifyAgentModelsChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRescanning(false);
    }
  }
  const defaultModel = catalog.defaultModel;
  // A CLI still listing its models may hold the default; decide once all have answered.
  const settled = catalog.status === "ready" && !catalog.loadingRuntimes?.length;
  // Without a default, a new conversation starts on the first model, one of OhMyGame's own.
  const defaultAgent = defaultModel && isAgentRuntimeId(defaultModel.provider) ? defaultModel.provider : undefined;
  const ownModels = catalog.models.filter((model) => !isAgentRuntimeId(model.provider));
  const noModels = catalog.status === "ready" && !ownModels.length;
  const startsOn = !defaultAgent ? (defaultModel && ownModels.find((model) => model.provider === defaultModel.provider && model.id === defaultModel.id)) ?? ownModels[0] : undefined;
  return (
    <>
      <SettingsGroup title={t("agents.builtIn")}>
        <SettingsRow
          className="settings-agent-row"
          icon={<BrandMark />}
          title={<>OhMyGame{settled && !defaultAgent ? <Badge tone="outline">{t("agents.default")}</Badge> : null}</>}
          description={noModels ? t("agents.ohmygameNoModels") : startsOn ? t("settings.agents.ohmygameModel", { model: startsOn.name }) : t("settings.agents.ohmygameSummary")}
          onClick={() => onOpen(OHMYGAME_AGENT)}
        >
          <IconButton size="sm" label={t("settings.agents.manage", { name: "OhMyGame" })} onClick={() => onOpen(OHMYGAME_AGENT)}>
            <ChevronRight size={16} />
          </IconButton>
        </SettingsRow>
      </SettingsGroup>
      <CodingAgentsGroup
        models={catalog.models}
        defaultAgent={defaultAgent}
        onOpen={onOpen}
        actions={
          <IconButton size="sm" label={t("agents.rescan")} disabled={rescanning} onClick={() => void rescan()}>
            <RefreshCw size={15} className={rescanning ? "spin" : undefined} />
          </IconButton>
        }
      />
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </>
  );
}

/**
 * The built-in agent. Its models come from Providers; a conversation picks
 * one in its model picker and new conversations start on the last one used.
 */
function OhMyGameAgent({ onBack, onOpenSection, onOpenPlugins }: {
  onBack: () => void;
  onOpenSection: (section: SettingsSection) => void;
  onOpenPlugins: () => void;
}) {
  const catalog = useAgentModels({ agentRuntimes: true });
  const ownModels = catalog.models.filter((model) => !isAgentRuntimeId(model.provider));
  const defaultModel = catalog.defaultModel && ownModels.find((model) => model.provider === catalog.defaultModel!.provider && model.id === catalog.defaultModel!.id);
  const chevron = <ChevronRight size={16} className="settings-row-chevron" />;
  return (
    <>
      <SettingsDetailHead mark={<BrandMark size={28} />} title="OhMyGame" description={t("settings.agents.ohmygameDescription")} onBack={onBack} backLabel={t("settings.agents.back")} />
      <SettingsGroup
        title={t("settings.agents.models")}
        description={t("settings.agents.modelsHint")}
        actions={<Button size="sm" variant="ghost" onClick={() => onOpenSection("providers")}>{t("agents.manageModels")}</Button>}
      >
        <SettingsRow
          title={t("settings.agents.chatModel")}
          description={catalog.status === "loading" ? t("common.loading") : !ownModels.length ? t("agents.ohmygameNoModels") : t("settings.agents.chatModelHint", { count: ownModels.length })}
        >
          {defaultModel ? <span className="settings-muted">{defaultModel.name}<span className="settings-count"> · {defaultModel.providerName}</span></span> : null}
        </SettingsRow>
        <SettingsRow title={t("settings.agents.mediaDefaults")} description={t("settings.agents.mediaDefaultsHint")} onClick={() => onOpenSection("providers")}>
          <IconButton size="sm" label={t("settings.agents.mediaDefaults")} onClick={() => onOpenSection("providers")}>{chevron}</IconButton>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t("settings.agents.skillsAndTools")}>
        <SettingsRow title={t("settings.agents.pluginSkills")} description={t("settings.agents.pluginSkillsHint")} onClick={onOpenPlugins}>
          <IconButton size="sm" label={t("settings.agents.pluginSkills")} onClick={onOpenPlugins}>{chevron}</IconButton>
        </SettingsRow>
        <SettingsRow title={t("settings.nav.mcpServer")} description={t("settings.agents.mcpHint")} onClick={() => onOpenSection("mcp-server")}>
          <IconButton size="sm" label={t("settings.nav.mcpServer")} onClick={() => onOpenSection("mcp-server")}>{chevron}</IconButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
