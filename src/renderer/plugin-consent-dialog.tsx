import { t } from "./i18n.js";
import { Bot, Clipboard, Cpu, FileText, Gamepad2, Globe2, History, Key, MousePointer2, Terminal, type IconComponent } from "./icons.js";
import { Alert, Badge } from "./ui/index.js";

/** Native code isn't sandboxed, so asking for it gets a warning wherever it is allowed. */
export function NativeCodeWarning({ asks }: { asks: readonly string[] }) {
  return asks.includes("native") ? <Alert tone="danger" title={t("projectPlugins.nativeWarning")}>{t("projectPlugins.nativeWarningHint")}</Alert> : null;
}

interface CapabilityRow { key: string; Icon: IconComponent; label: string; grants: string[]; items?: string[] }

/** Grants that are one line each, in the order they are listed. */
type SingleGrantLabel = "native" | "filesWrite" | "filesRead" | "selection" | "composer" | "history" | "usage" | "agent" | "game" | "secrets";
const SINGLE_GRANTS: readonly [grant: string, Icon: IconComponent, label: SingleGrantLabel][] = [
  ["native", Cpu, "native"],
  ["project.files:write", FileText, "filesWrite"],
  ["project.files:read", FileText, "filesRead"],
  ["project.selection", MousePointer2, "selection"],
  ["composer", Clipboard, "composer"],
  ["project.history", History, "history"],
  ["project.usage", History, "usage"],
  ["agent", Bot, "agent"],
  ["game", Gamepad2, "game"],
  ["secrets", Key, "secrets"],
];

/**
 * Grants such as `network:api.example.com` as one line per kind of access:
 * hosts and commands are listed under their line instead of one line each.
 */
function capabilityRows(capabilities: readonly string[]): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  const group = (prefix: string, Icon: IconComponent, label: string) => {
    const grants = capabilities.filter((capability) => capability.startsWith(prefix));
    if (grants.length) rows.push({ key: prefix, Icon, label, grants, items: grants.map((grant) => grant.slice(prefix.length)) });
  };
  group("process:", Terminal, t("pluginCapabilities.processes"));
  group("network:", Globe2, t("pluginCapabilities.network"));
  for (const [grant, Icon, label] of SINGLE_GRANTS)
    if (capabilities.includes(grant)) rows.push({ key: grant, Icon, label: t(`pluginCapabilities.${label}`), grants: [grant] });
  // A grant from a newer plugin API still shows, as it is written.
  for (const grant of capabilities)
    if (!rows.some((row) => row.grants.includes(grant))) rows.push({ key: grant, Icon: Key, label: grant, grants: [grant] });
  // Running its own code outweighs the rest, so it leads.
  return rows.sort((a, b) => Number(b.key === "native") - Number(a.key === "native"));
}

/**
 * What a plugin asks for, one readable line per kind of access. With
 * `newAsks`, an update marks what it asks for that wasn't allowed before.
 */
export function PluginCapabilityList({ capabilities, newAsks }: { capabilities: readonly string[]; newAsks?: readonly string[] }) {
  const fresh = (grant: string) => Boolean(newAsks?.includes(grant));
  return <ul className="plugin-capability-list">
    {capabilityRows(capabilities).map((row) => <li key={row.key} className={row.key === "native" ? "is-danger" : undefined}>
      <span className="plugin-capability-icon" aria-hidden="true"><row.Icon size={15} /></span>
      <span className="plugin-capability-text">
        <span>{row.label}{!row.items && row.grants.some(fresh) ? <Badge tone="outline">{t("pluginAdd.newAsk")}</Badge> : null}</span>
        {row.items ? <span className="plugin-capability-items">{row.items.map((item, index) => <code key={item} className={fresh(row.grants[index]!) ? "is-new" : undefined}
          title={fresh(row.grants[index]!) ? t("pluginAdd.newAsk") : undefined}>{item}</code>)}</span> : null}
      </span>
    </li>)}
  </ul>;
}
