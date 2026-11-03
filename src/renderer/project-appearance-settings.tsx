import { useEffect, useId, useRef, useState } from "react";
import type { ProjectAppearance, ProjectCoverMode, ProjectState } from "../shared/contracts.js";
import { PROJECT_ICONS, PROJECT_TONES, projectSymbol, type ProjectIcon } from "../shared/project-appearance.js";
import {
  getProjectCover,
  getProjectCoverState,
  getProjectLogo,
  setProjectAppearance,
  setProjectCover,
  setProjectCoverMode,
  setProjectLogo,
} from "./api.js";
import { refreshRecentProject } from "./app-sidebar.js";
import { ChevronDown, LoaderCircle, Upload } from "./icons.js";
import { imageToLogo, imageToWebP } from "./image.js";
import { PROJECT_ICON_SYMBOLS, ProjectPlaceholder } from "./project-placeholder.js";
import { Button, Dialog, SegmentedControl } from "./ui/index.js";
import { t } from "./i18n.js";

type CoverChoice = ProjectCoverMode | "template";

/**
 * The project's icon and cover, applied as soon as they change. The icon is an
 * uploaded logo or one from the default library; the cover is captured from the
 * preview, the default template, or an uploaded image.
 */
export function ProjectAppearanceSettings({ project, disabled = false, standalone = false }: {
  project: ProjectState;
  disabled?: boolean;
  /** In its own dialog, whose title names the section. */
  standalone?: boolean;
}) {
  const headingId = useId();
  const logoInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState(project);
  const [coverMode, setCoverMode] = useState<ProjectCoverMode>();
  const [coverUrl, setCoverUrl] = useState<string>();
  const [logoUrl, setLogoUrl] = useState<string>();
  // The default icons and colours fold away until asked for.
  const [libraryOpen, setLibraryOpen] = useState(false);
  const libraryId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const appearance = current.appearance ?? {};
  const symbol = projectSymbol(current.id, appearance);
  const cover: CoverChoice | undefined = appearance.cover === "template" ? "template" : coverMode;

  useEffect(() => {
    let disposed = false;
    void getProjectCoverState(current.id).then((state) => {
      if (!disposed) setCoverMode(state.mode);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [current.id]);

  useEffect(() => objectUrl(appearance.cover === "template" ? undefined : () => getProjectCover(current.id), setCoverUrl), [current.id, current.updatedAt, appearance.cover]);
  useEffect(() => objectUrl(appearance.logo ? () => getProjectLogo(current.id) : undefined, setLogoUrl), [current.id, current.updatedAt, appearance.logo]);

  async function apply(change: () => Promise<ProjectState>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await change();
      setCurrent(updated);
      refreshRecentProject(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  // The logo follows its own upload; every other change saves the icon, tone
  // and template together, which also tells the lists to reload the images.
  const save = (next: Omit<ProjectAppearance, "logo">) => setProjectAppearance(current.id, {
    ...(next.icon ? { icon: next.icon } : {}),
    ...(next.tone !== undefined ? { tone: next.tone } : {}),
    ...(next.cover ? { cover: next.cover } : {}),
  });
  const { logo: _logo, ...saved } = appearance;

  function chooseIcon(icon: ProjectIcon): void {
    void apply(async () => {
      if (appearance.logo) await setProjectLogo(current.id, undefined);
      return save({ ...saved, icon });
    });
  }

  function chooseTone(tone: number): void {
    void apply(() => save({ ...saved, tone }));
  }

  function uploadLogo(file: File | undefined): void {
    if (!file) return;
    void apply(async () => setProjectLogo(current.id, await imageToLogo(file)));
  }

  function resetIcon(): void {
    void apply(async () => {
      if (appearance.logo) await setProjectLogo(current.id, undefined);
      return save({ ...(saved.cover ? { cover: saved.cover } : {}) });
    });
  }

  function chooseCover(choice: CoverChoice): void {
    if (choice === cover) return;
    if (choice === "custom" && coverMode !== "custom") {
      coverInput.current?.click();
      return;
    }
    void apply(async () => {
      if (choice !== "template" && coverMode !== choice) {
        await setProjectCoverMode(current.id, choice);
        setCoverMode(choice);
      }
      return save({ ...saved, cover: choice === "template" ? "template" : undefined });
    });
  }

  function uploadCover(file: File | undefined): void {
    if (!file) return;
    void apply(async () => {
      await setProjectCover(current.id, await imageToWebP(file));
      setCoverMode("custom");
      return save({ ...saved, cover: undefined });
    });
  }

  return (
    <section className={`project-appearance${standalone ? "" : " project-settings-group"}`} aria-labelledby={standalone ? undefined : headingId} aria-label={standalone ? t("projectAppearance.title") : undefined}>
      {standalone ? null : <h3 id={headingId}>{t("projectAppearance.title")}</h3>}
      <fieldset className="project-settings-section" disabled={disabled || busy}>
        <div className="project-appearance-row">
          <span className="project-appearance-logo" aria-hidden="true">
            {logoUrl ? <img src={logoUrl} alt="" /> : <ProjectPlaceholder projectId={current.id} appearance={appearance} size={26} />}
          </span>
          <div className="project-appearance-copy">
            <strong>{t("projectAppearance.icon")}</strong>
            <span>{t("projectAppearance.iconHint")}</span>
          </div>
          <div className="project-appearance-actions">
            <Button size="sm" variant="ghost" className={`project-appearance-library-toggle${libraryOpen ? " is-open" : ""}`} aria-expanded={libraryOpen} aria-controls={libraryId}
              icon={<ChevronDown size={14} />} onClick={() => setLibraryOpen((open) => !open)}>{t("projectAppearance.library")}</Button>
            <Button size="sm" icon={<Upload size={14} />} onClick={() => logoInput.current?.click()}>{t("projectAppearance.upload")}</Button>
            {appearance.logo || appearance.icon || appearance.tone !== undefined
              ? <Button size="sm" variant="ghost" onClick={resetIcon}>{t("projectAppearance.reset")}</Button>
              : null}
          </div>
          <input ref={logoInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
            uploadLogo(event.target.files?.[0]);
            event.target.value = "";
          }} />
        </div>
        {libraryOpen ? <div id={libraryId} className="project-appearance-library">
        <div className="project-appearance-icons" role="radiogroup" aria-label={t("projectAppearance.library")}>
          {PROJECT_ICONS.map((icon) => {
            const Symbol = PROJECT_ICON_SYMBOLS[icon];
            const checked = !appearance.logo && symbol.icon === icon;
            return (
              <button key={icon} type="button" role="radio" aria-checked={checked} aria-label={t(`projectAppearance.icons.${icon}`)} title={t(`projectAppearance.icons.${icon}`)}
                className="project-appearance-icon" onClick={() => chooseIcon(icon)}>
                <Symbol size={18} aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div className="project-appearance-tones" role="radiogroup" aria-label={t("projectAppearance.tone")}>
          {Array.from({ length: PROJECT_TONES }, (_, tone) => (
            <button key={tone} type="button" role="radio" aria-checked={symbol.tone === tone}
              aria-label={t("projectAppearance.toneOption", { number: tone + 1 })}
              className="project-appearance-tone" style={{ background: `var(--project-cover-bg-${tone})` }}
              onClick={() => chooseTone(tone)} />
          ))}
        </div>
        </div> : null}
        <div className="project-appearance-row project-appearance-cover-row">
          <span className="project-appearance-cover" aria-hidden="true">
            {coverUrl ? <img src={coverUrl} alt="" /> : <ProjectPlaceholder projectId={current.id} appearance={appearance} size={26} />}
          </span>
          <div className="project-appearance-copy">
            <strong>{t("projectAppearance.cover")}</strong>
            <span>{t(`projectAppearance.coverHint.${cover ?? "auto"}`)}</span>
            <SegmentedControl<CoverChoice>
              size="sm"
              label={t("projectAppearance.cover")}
              value={cover ?? "auto"}
              options={[
                { value: "auto", label: t("projectAppearance.coverAuto") },
                { value: "template", label: t("projectAppearance.coverTemplate") },
                { value: "custom", label: t("projectAppearance.coverCustom") },
              ]}
              onChange={chooseCover}
            />
          </div>
          {cover === "custom"
            ? <Button size="sm" icon={<Upload size={14} />} onClick={() => coverInput.current?.click()}>{t("projectAppearance.replace")}</Button>
            : null}
          <input ref={coverInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
            uploadCover(event.target.files?.[0]);
            event.target.value = "";
          }} />
        </div>
        {busy ? <p className="project-settings-hint" role="status"><LoaderCircle className="spin" size={13} />{t("common.saving")}</p> : null}
        {error ? <p className="project-settings-error" role="alert">{error}</p> : null}
      </fieldset>
    </section>
  );
}

/** Loads an image as an object URL, revoked when it changes or unmounts. */
function objectUrl(load: (() => Promise<Blob | undefined>) | undefined, set: (url: string | undefined) => void): () => void {
  set(undefined);
  if (!load) return () => {};
  let disposed = false;
  let url: string | undefined;
  void load().then((blob) => {
    if (disposed || !blob) return;
    url = URL.createObjectURL(blob);
    set(url);
  }).catch(() => {});
  return () => {
    disposed = true;
    if (url) URL.revokeObjectURL(url);
  };
}

/** The appearance on its own, from the project menu, for every project type. */
export function ProjectAppearanceDialog({ project, open, onClose }: { project: ProjectState; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={t("projectAppearance.title")} footer={<Button onClick={onClose}>{t("common.done")}</Button>}>
      <ProjectAppearanceSettings key={project.id} project={project} standalone />
    </Dialog>
  );
}
