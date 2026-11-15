import { useEffect, useRef, useState } from "react";
import type { SavedToolApproval } from "../shared/plugin-hooks.js";
import { readPluginToolAccess, revokePluginToolAccess } from "./api.js";
import { t } from "./i18n.js";
import { Button } from "./ui/index.js";

export function PluginToolAccess({
  id,
  active,
}: {
  id: string;
  active: boolean;
}) {
  const [grants, setGrants] = useState<SavedToolApproval[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const acting = useRef(false);
  const alive = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let disposed = false;
    const refresh = () => {
      if (acting.current) return;
      const version = ++generation.current;
      void readPluginToolAccess(id, controller.signal).then(
        (value) => {
          if (!disposed && generation.current === version) {
            setGrants(value);
            setError(undefined);
          }
        },
        (cause: unknown) => {
          if (!disposed && generation.current === version)
            setError(message(cause));
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      generation.current++;
      controller.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [id, active]);

  async function revoke(key: string) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    generation.current++;
    try {
      const value = await revokePluginToolAccess(id, key);
      if (alive.current) {
        setGrants(value);
        setError(undefined);
        if (activeRef.current) heading.current?.focus();
      }
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="plugin-connection" aria-label={t("pluginAccess.title")}>
      <h2 ref={heading} tabIndex={-1}>
        {t("pluginAccess.title")}
      </h2>
      <p className="plugins-note">{t("pluginAccess.detail")}</p>
      {error ? <p role="alert">{error}</p> : null}
      {!grants && !error ? (
        <p role="status">{t("pluginControls.loadingConfiguration")}</p>
      ) : null}
      {grants?.length === 0 ? <p>{t("pluginAccess.empty")}</p> : null}
      {grants?.length ? (
        <ul className="plugin-tool-access">
          {grants.map((grant) => (
            <li key={grant.key}>
              <span>{grant.label}</span>
              <Button
                size="sm"
                disabled={busy}
                aria-label={t("pluginAccess.revokeLabel", {
                  label: grant.label,
                })}
                onClick={() => void revoke(grant.key)}
              >
                {t("pluginAccess.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
