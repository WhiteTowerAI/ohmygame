import { useState } from "react";
import { useRuntimeConnection } from "./runtime-connection.js";
import { t } from "./i18n.js";

export function RuntimeNotice() {
  const state = useRuntimeConnection();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  if (
    !window.ohMyGameDesktop?.runtimeService ||
    state.status === "ready" ||
    state.status === "stopped"
  )
    return null;
  const recovering =
    state.status === "starting" || state.status === "recovering" || pending;
  return (
    <aside
      className="runtime-notice"
      role={recovering ? "status" : "alert"}
      aria-live="polite"
    >
      <div>
        <strong>
          {recovering
            ? t("runtimeNotice.reconnecting")
            : t("runtimeNotice.stopped")}
        </strong>
        <p>
          {recovering
            ? t("runtimeNotice.kept")
            : t("runtimeNotice.restartHint")}
        </p>
        {state.error || error ? (
          <details>
            <summary>{t("common.errorDetails")}</summary>
            <pre>{error ?? state.error}</pre>
          </details>
        ) : null}
      </div>
      {!recovering ? (
        <button
          type="button"
          onClick={() => {
            setPending(true);
            setError(undefined);
            void window
              .ohMyGameDesktop!.runtimeService!.restart()
              .catch((cause) =>
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
              .finally(() => setPending(false));
          }}
        >
          {t("runtimeNotice.restart")}
        </button>
      ) : null}
    </aside>
  );
}
