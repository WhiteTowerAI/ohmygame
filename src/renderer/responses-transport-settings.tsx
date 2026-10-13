import { useEffect, useId, useState } from "react";
import type { ResponsesTransportMode } from "../shared/contracts.js";
import { getResponsesTransport, updateResponsesTransport } from "./api.js";
import { t } from "./i18n.js";

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
    <section
      className="settings-detail-section"
      aria-label={t("responsesTransport.label")}
    >
      <div className="settings-detail-field">
        <label className="settings-search-field-label" htmlFor={id}>
          {t("responsesTransport.title")}
        </label>
        <select
          id={id}
          className="settings-search-input"
          value={mode}
          disabled={disabled || loading || saving}
          onChange={(event) =>
            void save(event.target.value as ResponsesTransportMode)
          }
        >
          <option value="auto">{t("customProvider.automatic")}</option>
          <option value="sse">HTTP / SSE</option>
          <option value="websocket">{t("responsesTransport.preferWebSocket")}</option>
        </select>
        <small className="settings-detail-hint">
          {t("responsesTransport.hint")}
        </small>
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
