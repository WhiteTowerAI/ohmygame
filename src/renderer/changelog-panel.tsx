import { useState } from "react";
import type { ChangelogEntry } from "../shared/changelog.js";
import type { DesktopUpdateState } from "../shared/desktop-update.js";
import { MarkdownContent } from "./markdown-content.js";
import { t } from "./i18n.js";

const RELEASES_URL = "https://github.com/WhiteTowerAI/ohmygame/releases";

export function ChangelogPanel({
  currentVersion,
  availableRelease,
}: {
  currentVersion: string;
  availableRelease?: DesktopUpdateState["availableRelease"];
}) {
  const [selection, setSelection] = useState<string>();
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
  const selected =
    entries.find((entry) => entry.version === selection) ??
    entries.find((entry) => entry.version === availableRelease?.version) ??
    entries.find((entry) => entry.version === currentVersion)!;
  return (
    <section
      className="settings-panel settings-overview-panel settings-changelog-panel"
      aria-label={t("settings.about.changelog")}
    >
      <header className="settings-changelog-header">
        <h3>{t("settings.about.changelog")}</h3>
        <div className="settings-changelog-meta">
          {entries.length > 1 ? (
            <select
              className="settings-changelog-version"
              aria-label={t("settings.about.releaseVersion")}
              value={selected.version}
              onChange={(event) => setSelection(event.target.value)}
            >
              {entries.map((entry) => (
                <option value={entry.version} key={entry.version}>
                  v{entry.version}
                </option>
              ))}
            </select>
          ) : (
            <span>v{selected.version}</span>
          )}
          {selected.date ? (
            <time dateTime={selected.date}>{selected.date}</time>
          ) : null}
        </div>
      </header>
      {selected.notes ? (
        <MarkdownContent
          className="settings-changelog-content"
          text={selected.notes}
        />
      ) : (
        <p className="settings-changelog-empty">
          {t("settings.about.notesUnavailable")}{" "}
          <a
            href={`${RELEASES_URL}/tag/v${encodeURIComponent(selected.version)}`}
            target="_blank"
            rel="noreferrer"
          >
            {t("settings.about.viewRelease")}
          </a>
        </p>
      )}
    </section>
  );
}
