import { useEffect, useState } from "react";
import type {
  ProviderCapability,
  ProviderSummary,
} from "../shared/contracts.js";
import { HYPER3D_CONNECTION_ID } from "../shared/cloud-models.js";
import { listProviders, MODELS_CHANGED_EVENT } from "./api.js";
import { LoaderCircle, Plus, Server } from "./icons.js";
import { GlobalMediaModelDefaults } from "./media-model-defaults.js";
import { ProviderAuthView } from "./models-settings.js";
import { CustomProviderForm } from "./custom-provider-dialog.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
import { t } from "./i18n.js";

const CAPABILITIES = ["image", "video", "3d", "audio"] as const;
type MediaCapability = (typeof CAPABILITIES)[number];

/** Optional setup reuses Settings' provider forms; it never changes the chat model. */
export function OnboardingMedia({
  busy,
  onSavingChange,
}: {
  busy: boolean;
  onSavingChange: (saving: boolean) => void;
}) {
  const [capability, setCapability] = useState<MediaCapability>("image");
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [detail, setDetail] = useState<ProviderSummary>();
  const [adding, setAdding] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const load = () => {
      const current = ++revision;
      void listProviders()
        .then((loaded) => {
          if (!active || current !== revision) return;
          setProviders(loaded);
          setError(undefined);
          setLoading(false);
        })
        .catch((cause) => {
          if (!active || current !== revision) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        });
    };
    load();
    window.addEventListener(MODELS_CHANGED_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.removeEventListener(MODELS_CHANGED_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, [refresh]);

  const back = () => {
    setDetail(undefined);
    setRefresh((value) => value + 1);
  };
  if (adding)
    return (
      <div className="onboarding-media-detail onboarding-media-custom">
        <h2>{t("onboarding.addProvider")}</h2>
        <CustomProviderForm
          onClose={() => setAdding(false)}
          onSavingChange={onSavingChange}
          onSaved={() => {
            setAdding(false);
            setRefresh((value) => value + 1);
          }}
        />
      </div>
    );
  if (detail)
    return (
      <div className="onboarding-media-detail">
        <ProviderAuthView
          key={detail.id}
          provider={detail}
          onBack={back}
          onCompleted={back}
        />
      </div>
    );

  const available = providers.filter(
    (provider) =>
      provider.capabilities.includes(capability) &&
      (provider.id !== HYPER3D_CONNECTION_ID ||
        !providers.some((item) => item.id === "hyper3d")),
  );
  const connected = (provider: ProviderSummary) =>
    mediaConnected(provider, capability);
  const row = (provider: ProviderSummary) => {
    const icon = PROVIDER_ICONS[provider.id];
    return (
      <div
        className="onboarding-provider-row"
        key={provider.id}
        role="group"
        aria-label={provider.name}
      >
        <span>
          {icon ? (
            <span
              className={`settings-provider-mark is-${icon.tone}`}
              aria-hidden="true"
            >
              <img src={icon.src} alt="" />
            </span>
          ) : (
            <Server size={18} aria-hidden="true" />
          )}
          {provider.name}
        </span>
        <div>
          {connected(provider) ? (
            <small className="onboarding-media-connected">
              {t("providers.status.connected")}
            </small>
          ) : null}
          <button
            type="button"
            className="onboarding-text-button"
            onClick={() => setDetail(provider)}
          >
            {t("onboarding.configure")}
          </button>
        </div>
      </div>
    );
  };
  return (
    <section
      className="onboarding-media"
      aria-label={t("onboarding.mediaStep")}
    >
      <div className="onboarding-media-toolbar">
        <div
          className="onboarding-media-filters"
          role="group"
          aria-label={t("providers.filterLabel")}
        >
          {CAPABILITIES.map((item) => (
            <button
              type="button"
              className="onboarding-text-button"
              key={item}
              aria-pressed={capability === item}
              onClick={() => setCapability(item)}
            >
              {t(`capability.${item}`)}
            </button>
          ))}
        </div>
        <button
          className="onboarding-text-button onboarding-add-provider"
          type="button"
          aria-label={t("onboarding.addCustomProvider")}
          title={t("onboarding.addCustomProvider")}
          disabled={busy}
          onClick={() => setAdding(true)}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      {loading ? (
        <p className="onboarding-status" role="status">
          <LoaderCircle className="spin" size={14} />
          {t("onboarding.loadingProviders")}
        </p>
      ) : (
        <>
          {available.some(connected) && capability !== "audio" ? (
            <GlobalMediaModelDefaults
              key={`${capability}:${refresh}`}
              capability={capability}
            />
          ) : null}
          <div className="onboarding-provider-list">
            {available.map(row)}
            {!available.length && !error ? (
              <p className="onboarding-lede">
                {t("onboarding.noMediaProviders")}
              </p>
            ) : null}
          </div>
        </>
      )}
      {error ? (
        <div className="onboarding-feedback">
          <p className="onboarding-error" role="alert">
            {error}
          </p>
          <button
            className="onboarding-text-button"
            type="button"
            onClick={() => {
              setLoading(true);
              setRefresh((value) => value + 1);
            }}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function mediaConnected(
  provider: ProviderSummary,
  capability: ProviderCapability,
): boolean {
  return (
    provider.enabled !== false &&
    (capability === "image"
      ? (provider.imageConfigured ?? provider.configured)
      : provider.configured)
  );
}
