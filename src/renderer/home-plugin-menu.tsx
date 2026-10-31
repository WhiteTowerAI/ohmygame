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
 * The plugins of the project Home is about to create: plugins whose skills
 * write the first answer, any number of them, and plugins turned on for this
 * project alone. The plugin a type comes from stays on while that type is
 * chosen. A plugin that asks for more than files is allowed here, before it is
 * chosen, as in the project's own Plugins sheet.
 */
export function HomePluginMenu({ starters, chosen, locked, onChosen, choices, selected, onSelected, failed = false, onRetry, disabled }: {
  starters: readonly Plugin[];
  /** The chosen starters' ids; the first one leads the prompt. */
  chosen: readonly string[];
  /** The starter the chosen type comes from. */
  locked?: string;
  onChosen: (ids: string[]) => void;
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
  const on = starters.filter((plugin) => chosen.includes(plugin.id))
    .sort((left, right) => chosen.indexOf(left.id) - chosen.indexOf(right.id));
  const turnedOn = choices.filter((choice) => selected.includes(choice.id));
  const names = [...on.map((plugin) => plugin.displayName), ...turnedOn.map((choice) => choice.displayName)];
  // A few chosen plugins show side by side; more show the first and how many follow it.
  const icons = [
    ...on.map((plugin) => ({ id: plugin.id, icon: <PluginGlyph plugin={plugin} size={16} /> })),
    ...turnedOn.map((choice) => ({ id: choice.id, icon: <Package size={14} /> })),
  ];
  const shown = icons.length <= 3 ? icons : icons.slice(0, 1);
  const others = icons.length - shown.length;
  const label = names.length ? t("home.pluginsWith", { names: names.join(", ") }) : t("home.plugins");

  function toggleStarter(plugin: Plugin): void {
    if (plugin.id === locked) return;
    onChosen(chosen.includes(plugin.id) ? chosen.filter((id) => id !== plugin.id) : [...chosen, plugin.id]);
  }

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
        {shown.length ? <span className="home-plugin-icons">
          {shown.map((item) => <span key={item.id} className="home-plugin-trigger-icon">{item.icon}</span>)}
        </span> : <Package size={15} />}
        {others > 0 ? <span className="home-plugin-count" aria-hidden="true">+{others}</span> : null}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={trigger} placement="bottom-start" className="home-plugin-menu" label={t("home.plugins")}>
        <div role="menu" aria-label={t("home.plugins")}>
          {starters.length ? <div className="home-plugin-section" role="group" aria-label={t("home.starter")}>
            <div className="home-plugin-heading">{t("home.starter")}</div>
            {starters.map((plugin) => (
              <PluginRow key={plugin.id} checked={chosen.includes(plugin.id)} disabled={plugin.id === locked} title={plugin.displayName}
                detail={plugin.id === locked ? t("home.typePlugin") : plugin.description}
                icon={<PluginGlyph plugin={plugin} size={18} />} onClick={() => toggleStarter(plugin)} />
            ))}
          </div> : null}
          <div className="home-plugin-section" role="group" aria-label={t("home.projectPlugins")}>
            <div className="home-plugin-heading">{t("home.projectPlugins")}</div>
            {choices.map((choice) => (
              <PluginRow key={choice.id} checked={selected.includes(choice.id)} title={choice.displayName} detail={choice.description}
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

function PluginRow({ checked, disabled = false, title, detail, icon, onClick }: {
  checked: boolean;
  disabled?: boolean;
  title: string;
  detail?: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} aria-disabled={disabled || undefined}
      className={`home-plugin-row${disabled ? " is-locked" : ""}`} onClick={onClick}>
      <span className="home-plugin-icon">{icon}</span>
      <span className="home-plugin-text">
        <span>{title}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
      <span className={`home-plugin-check${checked ? " is-on" : ""}`} aria-hidden="true">{checked ? <Check size={12} /> : null}</span>
    </button>
  );
}
