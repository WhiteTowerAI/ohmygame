import type { ChangelogEntry } from "../shared/changelog.js";
import type { DesktopUpdateState } from "../shared/desktop-update.js";
import { MarkdownContent } from "./markdown-content.js";
import { t } from "./i18n.js";
import { SettingsGroup } from "./settings-parts.js";
import { Collapsible } from "./ui/index.js";

const RELEASES_URL = "https://github.com/WhiteTowerAI/ohmygame/releases";
/** Older releases are on GitHub. */
const SHOWN_RELEASES = 6;

export function ChangelogPanel({
  currentVersion,
  availableRelease,
}: {
  currentVersion: string;
  availableRelease?: DesktopUpdateState["availableRelease"];
}) {
  const entries: Array<Omit<ChangelogEntry, "date"> & { date?: string }> = [
    ...__APP_CHANGELOG__,
  ];
  if (!entries.some((entry) => entry.version === currentVersion))
    entries.unshift({ version: currentVersion, notes: "" });
  if (availableRelease && availableRelease.version !== currentVersion) {
    const index = entries.findIndex(
      (entry) => entry.version === availableRelease.version,
    );
    const bundled = entries[index];
    if (index >= 0) entries.splice(index, 1);
    entries.unshift({
      ...bundled,
      ...availableRelease,
      notes: availableRelease.notes || bundled?.notes || "",
    });
  }
  // The release the person is about to get, else the one they run, starts open.
  const open = entries.find((entry) => entry.version === availableRelease?.version)?.version ?? currentVersion;
  const shown = entries.slice(0, SHOWN_RELEASES);
  if (!shown.some((entry) => entry.version === open)) shown.push(entries.find((entry) => entry.version === open)!);
  return (
    <SettingsGroup
      title={t("settings.about.changelog")}
      actions={entries.length > shown.length ? (
        <a className="ui-button ui-button-ghost ui-button-sm" href={RELEASES_URL} target="_blank" rel="noreferrer">{t("settings.about.allReleases")}</a>
      ) : undefined}
    >
      {shown.map((entry) => (
          <Collapsible
            key={`${entry.version}:${open}`}
            title={`v${entry.version}`}
            meta={entry.date ? <time dateTime={entry.date}>{entry.date}</time> : undefined}
            defaultOpen={entry.version === open}
          >
            {entry.notes ? (
              <MarkdownContent className="settings-changelog settings-changelog-content" text={entry.notes} />
            ) : (
              <p className="settings-changelog settings-changelog-empty">
                {t("settings.about.notesUnavailable")}{" "}
                <a href={`${RELEASES_URL}/tag/v${encodeURIComponent(entry.version)}`} target="_blank" rel="noreferrer">
                  {t("settings.about.viewRelease")}
                </a>
              </p>
            )}
          </Collapsible>
      ))}
    </SettingsGroup>
  );
}
