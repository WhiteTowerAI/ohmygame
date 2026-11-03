import { useEffect, useId, useState } from "react";
import type { ResponsesTransportMode } from "../shared/contracts.js";
import { getResponsesTransport, updateResponsesTransport } from "./api.js";
import { t } from "./i18n.js";
import { Select } from "./ui/index.js";

export function ProviderResponsesTransport({
  providerId,
  disabled = false,
}: {
  providerId: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [mode, setMode] = useState<ResponsesTransportMode>("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void getResponsesTransport(providerId)
      .then((settings) => {
        if (active) setMode(settings.mode);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [providerId]);
  async function save(value: ResponsesTransportMode) {
    setSaving(true);
    setError(undefined);
    try {
      setMode((await updateResponsesTransport(providerId, value)).mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="settings-card settings-responses-transport" aria-label={t("responsesTransport.label")}>
      <div className="settings-row">
        <div className="settings-row-text">
          <strong id={id}>{t("responsesTransport.title")}</strong>
          <span title={t("responsesTransport.hint")}>{t("responsesTransport.shortHint")}</span>
        </div>
        <Select<ResponsesTransportMode>
          size="sm"
          label={t("responsesTransport.title")}
          value={mode}
          disabled={disabled || loading || saving}
          onChange={(value) => void save(value)}
          options={[
            { value: "auto", label: t("customProvider.automatic") },
            { value: "sse", label: "HTTP / SSE" },
            { value: "websocket", label: t("responsesTransport.preferWebSocket") },
          ]}
        />
      </div>
      {error ? (
        <p className="settings-error settings-pad" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
