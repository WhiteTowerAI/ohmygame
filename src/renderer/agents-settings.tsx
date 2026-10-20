import { useState } from "react";
import { RefreshCw, Server } from "./icons.js";
import {
  isAgentRuntimeId,
  type AgentRuntimeId,
} from "../shared/agent-runtimes.js";
import { listAgentRuntimes, notifyAgentModelsChanged } from "./api.js";
import {
  CodingAgentDetail,
  CodingAgentsGroup,
} from "./coding-agents-settings.js";
import { useAgentModels } from "./model-selector.js";
import { t } from "./i18n.js";
import brandMark from "../shared/assets/ohmygame-mark-v2.svg";

export type AgentsView =
  { page: "agents" } | { page: "agent"; id: AgentRuntimeId };

/**
 * Who does the work in a conversation: OhMyGame's own agent, which uses the
 * models set up in Providers & Models, and the coding agent CLIs on this
 * computer, which bring their own models and accounts. A conversation picks
 * one in its model picker; this page sets them up.
 */
export function AgentsSettings({
  view,
  onViewChange,
  onOpenProviders,
}: {
  view: AgentsView;
  onViewChange: (view: AgentsView) => void;
  onOpenProviders: () => void;
}) {
  if (view.page === "agent")
    return (
      <CodingAgentDetail
        id={view.id}
        onBack={() => onViewChange({ page: "agents" })}
      />
    );
  return (
    <AgentList
      onOpen={(id) => onViewChange({ page: "agent", id })}
      onOpenProviders={onOpenProviders}
    />
  );
}

function AgentList({
  onOpen,
  onOpenProviders,
}: {
  onOpen: (id: AgentRuntimeId) => void;
  onOpenProviders: () => void;
}) {
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
  const settled =
    catalog.status === "ready" && !catalog.loadingRuntimes?.length;
  // Without a default, a new conversation starts on the first model, one of OhMyGame's own.
  const defaultAgent =
    defaultModel && isAgentRuntimeId(defaultModel.provider)
      ? defaultModel.provider
      : undefined;
  const noModels =
    catalog.status === "ready" &&
    !catalog.models.some((model) => !isAgentRuntimeId(model.provider));
  return (
    <section className="settings-panel settings-overview-panel">
      <header className="settings-panel-header">
        <h3>{t("agents.title")}</h3>
        <button
          className="icon-button"
          type="button"
          disabled={rescanning}
          aria-label={t("agents.rescan")}
          data-tooltip={t("agents.rescan")}
          onClick={() => void rescan()}
        >
          <RefreshCw
            size={15}
            className={rescanning ? "spin" : undefined}
            aria-hidden="true"
          />
        </button>
      </header>
      <div className="settings-provider-list">
        <section className="settings-provider-group">
          <h4>{t("agents.builtIn")}</h4>
          <div className="settings-provider-row is-featured">
            <span
              className="settings-provider-mark is-brand"
              aria-hidden="true"
            >
              <img src={brandMark} alt="" />
            </span>
            <span className="settings-provider-copy">
              <strong className="settings-provider-name">
                <span>OhMyGame</span>
                {settled && !defaultAgent ? (
                  <small>{t("agents.default")}</small>
                ) : null}
              </strong>
              {noModels ? (
                <span className="settings-provider-details">
                  <span className="settings-provider-description">
                    {t("agents.ohmygameNoModels")}
                  </span>
                </span>
              ) : null}
            </span>
            <button
              className="icon-button settings-provider-action"
              type="button"
              data-tooltip={t("agents.manageModels")}
              aria-label={t("agents.manageModels")}
              onClick={onOpenProviders}
            >
              <Server size={17} aria-hidden="true" />
            </button>
          </div>
        </section>
        <CodingAgentsGroup
          models={catalog.models}
          defaultAgent={defaultAgent}
          onOpen={onOpen}
        />
        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
