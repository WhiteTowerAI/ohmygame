import { useState } from "react";
import type { ChangelogEntry } from "../shared/changelog.js";
import type { DesktopUpdateState } from "../shared/desktop-update.js";
import { MarkdownContent } from "./markdown-content.js";
import { t } from "./i18n.js";
import { SettingsGroup } from "./settings-parts.js";
import { Select } from "./ui/index.js";

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
  const versions = entries.map((entry) => ({ value: entry.version, label: `v${entry.version}` }));
  return (
    <SettingsGroup
      title={t("settings.about.changelog")}
      description={selected.date ? <time dateTime={selected.date}>{selected.date}</time> : undefined}
      actions={
        entries.length > 1 ? (
          <Select
            size="sm"
            label={t("settings.about.releaseVersion")}
            options={versions}
            value={selected.version}
            onChange={setSelection}
          />
        ) : (
          <span className="settings-muted">v{selected.version}</span>
        )
      }
    >
      {selected.notes ? (
        <MarkdownContent
          className="settings-changelog settings-changelog-content"
          text={selected.notes}
        />
      ) : (
        <p className="settings-changelog settings-changelog-empty">
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
    </SettingsGroup>
  );
}
