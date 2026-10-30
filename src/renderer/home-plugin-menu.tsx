import { useRef, useState } from "react";
import type { ConversationCapabilities } from "../shared/contracts.js";
import type { ProjectPluginChoice } from "../shared/plugins.js";
import { Check, Package } from "./icons.js";
import { t } from "./i18n.js";
import { PluginGlyph } from "./plugin-icons.js";
import { pluginHash } from "./routes.js";
import { Button, Dialog, Popover } from "./ui/index.js";

type Plugin = ConversationCapabilities["plugins"][number];

/**
 * The plugins of the project Home is about to create: the plugin it starts
 * with, whose skills write the first answer, and plugins turned on for this
 * project alone. A plugin that asks for more than files is allowed here,
 * before it is chosen, as in the project's own Plugins sheet.
 */
export function HomePluginMenu({ starters, starter, onStarter, choices, selected, onSelected, failed = false, onRetry, disabled }: {
  starters: readonly Plugin[];
  starter?: Plugin;
  onStarter: (id: string | undefined) => void;
  choices: readonly ProjectPluginChoice[];
  selected: readonly string[];
  onSelected: (ids: string[]) => void;
  /** The plugins a project can turn on failed to load. */
  failed?: boolean;
  onRetry?: () => void;
  disabled?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState<ProjectPluginChoice>();
  const count = selected.length;
  const label = starter
    ? t("home.pluginsWith", { name: starter.displayName })
    : t("home.plugins");

  function toggle(choice: ProjectPluginChoice): void {
    if (selected.includes(choice.id)) {
      onSelected(selected.filter((id) => id !== choice.id));
      return;
    }
    if (!choice.consented && choice.capabilities.length) {
      setOpen(false);
      setConsent(choice);
      return;
    }
    onSelected([...selected, choice.id]);
  }

  return (
    <>
      <button ref={trigger} type="button" className="home-plugin-trigger" disabled={disabled}
        aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        {starter ? <PluginGlyph plugin={starter} size={16} /> : <Package size={15} />}
        {count ? <span className="home-plugin-count" aria-hidden="true">+{count}</span> : null}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={trigger} placement="bottom-end" className="home-plugin-menu" label={t("home.plugins")}>
        <div role="menu" aria-label={t("home.plugins")}>
          <div className="home-plugin-section" role="group" aria-label={t("home.starter")}>
            <div className="home-plugin-heading">{t("home.starter")}</div>
            {starters.map((plugin) => (
              <PluginRow key={plugin.id} role="menuitemradio" checked={starter?.id === plugin.id} title={plugin.displayName} detail={plugin.description}
                icon={<PluginGlyph plugin={plugin} size={18} />} onClick={() => { onStarter(plugin.id); setOpen(false); }} />
            ))}
            <PluginRow role="menuitemradio" checked={!starter} title={t("home.noStarter")} detail={t("home.noStarterHint")}
              icon={<Package size={16} />} onClick={() => { onStarter(undefined); setOpen(false); }} />
          </div>
          <div className="home-plugin-section" role="group" aria-label={t("home.projectPlugins")}>
            <div className="home-plugin-heading">{t("home.projectPlugins")}</div>
            {choices.map((choice) => (
              <PluginRow key={choice.id} role="menuitemcheckbox" checked={selected.includes(choice.id)} title={choice.displayName} detail={choice.description}
                icon={<Package size={16} />} onClick={() => toggle(choice)} />
            ))}
            {failed ? <p className="home-plugin-empty" role="alert">
              {t("home.projectPluginsFailed")}{" "}
              <Button size="sm" variant="ghost" onClick={onRetry}>{t("common.retry")}</Button>
            </p> : !choices.length ? <p className="home-plugin-empty">
              {t("home.noProjectPlugins")}{" "}
              <a href={pluginHash()} onClick={() => setOpen(false)}>{t("home.browsePlugins")}</a>
            </p> : null}
          </div>
        </div>
      </Popover>
      {consent ? <Dialog open title={t("projectPlugins.consentTitle", { name: consent.displayName })} onClose={() => setConsent(undefined)}
        footer={<>
          <Button variant="ghost" onClick={() => setConsent(undefined)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => {
            onSelected([...selected, consent.id]);
            setConsent(undefined);
          }}>{t("projectPlugins.allow")}</Button>
        </>}>
        <p>{t("projectPlugins.consentHint")}</p>
        <ul className="project-plugins-capabilities">
          {consent.capabilities.map((capability) => <li key={capability}><code>{capability}</code></li>)}
        </ul>
      </Dialog> : null}
    </>
  );
}

function PluginRow({ role, checked, title, detail, icon, onClick }: {
  role: "menuitemradio" | "menuitemcheckbox";
  checked: boolean;
  title: string;
  detail?: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" role={role} aria-checked={checked} className="home-plugin-row" onClick={onClick}>
      <span className="home-plugin-icon">{icon}</span>
      <span className="home-plugin-text">
        <span>{title}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
      <span className="home-plugin-check">{checked ? <Check size={14} /> : null}</span>
    </button>
  );
}
