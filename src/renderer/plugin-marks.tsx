import type { ReactNode } from "react";
import { t } from "./i18n.js";
import { Badge } from "./ui/index.js";

// The marks beside a plugin's name, the same on every card, dialog and page.
// Only Official is an icon: a solid blue seal, like a verified account. The
// rest are quiet text labels; only what needs the person (stopped, blocked, a
// failed development build) is red. Whether a source is verified is not a
// mark: it is in the plugin's information.

export type PluginMark = "beta" | "included" | "development" | "development-error" | "off" | "update" | "stopped" | "blocked";

const LABELS = {
  beta: "plugins.beta",
  included: "plugins.included",
  development: "plugins.inDevelopment",
  "development-error": "plugins.inDevelopment",
  off: "common.disabled",
  update: "pluginStore.updateAvailable",
  stopped: "pluginLog.stoppedBadge",
  blocked: "pluginStore.blockedBadge",
} as const satisfies Record<PluginMark, string>;
const ALERTS: ReadonlySet<PluginMark> = new Set(["development-error", "stopped", "blocked"]);

/** OhMyGame's own plugin: a blue seal with a check. */
export function OfficialMark({ size = 14 }: { size?: number }): ReactNode {
  return <svg className="plugin-official-mark" role="img" aria-label={t("plugins.official")} width={size} height={size} viewBox="0 0 24 24">
    <title>{t("plugins.official")}</title>
    <path fill="currentColor" d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
    <path fill="none" stroke="var(--color-on-accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="m8.5 12 2.5 2.5 4.5-5" />
  </svg>;
}

/** The marks after a plugin's name: the seal when it is official, then its labels. */
export function PluginMarks({ official = false, marks = [] }: { official?: boolean; marks?: readonly (PluginMark | false | undefined)[] }): ReactNode {
  const shown = marks.filter((mark): mark is PluginMark => Boolean(mark));
  return <>
    {official ? <OfficialMark /> : null}
    {shown.map((mark) => <Badge key={mark} tone={ALERTS.has(mark) ? "danger" : "outline"}>{t(LABELS[mark])}</Badge>)}
  </>;
}
