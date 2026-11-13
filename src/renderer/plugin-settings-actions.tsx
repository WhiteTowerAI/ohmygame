import { useEffect, useRef, useState } from "react";
import type { StorePlugin } from "../shared/plugins.js";
import type { PluginSettingsStatus } from "../shared/plugin-settings.js";
import { readPluginSettingsStatus, runPluginSettingsAction } from "./api.js";
import { language, t } from "./i18n.js";
import { Copy } from "./icons.js";
import { Button } from "./ui/index.js";

/** The plugin owns pairing. This view only observes it and issues explicit local actions. */
export function PluginSettingsActions({
  plugin,
  active,
  enabled,
  onConfigurationChanged,
}: {
  plugin: StorePlugin;
  active: boolean;
  enabled: boolean;
  onConfigurationChanged?: () => void;
}) {
  const [status, setStatus] = useState<PluginSettingsStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string>();
  const generation = useRef(0);
  const acting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (!active || !enabled || !plugin.settingsView?.status) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      if (!acting.current) {
        const version = ++generation.current;
        try {
          const value = await readPluginSettingsStatus(
            plugin.id,
            controller.signal,
          );
          if (!disposed && version === generation.current) {
            setStatus(value);
            setError(undefined);
          }
        } catch (cause) {
          if (!disposed && version === generation.current)
            setError(message(cause));
        }
      }
      if (!disposed)
        timer = setTimeout(() => {
          void poll();
        }, 2_000);
    };
    void poll();
    return () => {
      disposed = true;
      generation.current++;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    plugin.id,
    plugin.revision,
    plugin.settingsView?.status,
    active,
    enabled,
  ]);

  async function act(command: string) {
    if (acting.current) return;
    acting.current = true;
    const version = ++generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const value = await runPluginSettingsAction(plugin.id, command);
      if (alive.current && value.configurationChanged)
        onConfigurationChanged?.();
      if (alive.current && version === generation.current) {
        setStatus(value);
        if (value.link && value.link.url !== status?.link?.url)
          await open(value.link.url);
      }
    } catch (cause) {
      if (alive.current && version === generation.current)
        setError(message(cause));
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function open(url: string) {
    if (window.ohMyGameDesktop) await window.ohMyGameDesktop.openExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
    } catch (cause) {
      setError(message(cause));
    }
  }

  return (
    <section
      className="plugin-connection"
      aria-label={t("pluginControls.connection")}
    >
      <h2>{t("pluginControls.connection")}</h2>
      {!enabled ? (
        <p>{t("pluginControls.enableConnection")}</p>
      ) : (
        <>
          <p role="status">
            {status?.message ?? t("pluginControls.loadingConfiguration")}
          </p>
          {status?.detail ? (
            <p className="plugins-note">{status.detail}</p>
          ) : null}
          {status?.link ? (
            <div className="plugin-pairing-code">
              <Button
                size="sm"
                onClick={() => {
                  void open(status.link!.url).catch((cause: unknown) =>
                    setError(message(cause)),
                  );
                }}
              >
                {status.link.title}
              </Button>
              <small>
                {t("pluginControls.codeExpires", {
                  time: new Date(status.link.expiresAt).toLocaleTimeString(
                    language,
                    { hour: "2-digit", minute: "2-digit" },
                  ),
                })}
              </small>
            </div>
          ) : null}
          {status?.code ? (
            <div className="plugin-pairing-code">
              <div>
                <code>{status.code.text}</code>
                <Button
                  size="sm"
                  icon={<Copy size={13} />}
                  onClick={() => {
                    void copy(status.code!.text);
                  }}
                >
                  {copied === status.code.text
                    ? t("common.copied")
                    : t("common.copy")}
                </Button>
              </div>
              <small>
                {t("pluginControls.codeExpires", {
                  time: new Date(status.code.expiresAt).toLocaleTimeString(
                    language,
                    { hour: "2-digit", minute: "2-digit" },
                  ),
                })}
              </small>
            </div>
          ) : null}
          <div className="plugin-connection-actions">
            {plugin.settingsView?.actions
              .filter((action) => status?.actions.includes(action.id))
              .map((action) => (
                <Button
                  key={action.id}
                  size="sm"
                  disabled={busy || !!error}
                  title={action.description}
                  onClick={() => {
                    void act(action.id);
                  }}
                >
                  {action.title}
                </Button>
              ))}
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </>
      )}
    </section>
  );
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
