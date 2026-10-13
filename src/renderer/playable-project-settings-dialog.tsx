import { useState, type FormEvent } from "react";
import type { ProjectState } from "../shared/contracts.js";
import type { NodeGraph } from "../shared/playable-nodes.js";
import {
  canvasFormatForViewport,
  canvasFormatPreset,
  canvasFormatSummary,
  type CanvasFormatPresetId,
  type Viewport,
} from "../shared/canvas-formats.js";
import { formatStateValue } from "../shared/playable-debug.js";
import { describePlayableValue } from "../shared/playable-editor.js";
import { CanvasFormatOptions } from "./canvas-format-options.js";
import { CircleHelp, Download, LoaderCircle } from "./icons.js";
import { ProjectSettingsDialogFrame } from "./project-settings-dialog.js";
import { t } from "./i18n.js";

const variablesHelp = t("storySettings.variablesHelp");

export function PlayableProjectSettingsDialog({
  project,
  graph,
  exporting,
  canExport,
  onSave,
  onExport,
  onClose,
}: {
  project: ProjectState;
  graph: NodeGraph;
  exporting: boolean;
  canExport: boolean;
  onSave: (viewport: Viewport) => Promise<void>;
  onExport: () => Promise<void>;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<CanvasFormatPresetId | undefined>(
    () => canvasFormatForViewport(graph.viewport)?.id,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const viewport = selection
    ? canvasFormatPreset(selection).viewport
    : graph.viewport;
  const changed =
    viewport.width !== graph.viewport.width ||
    viewport.height !== graph.viewport.height;
  const names = Object.keys(graph.initialState);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving || exporting) return;
    setSaving(true);
    setError(undefined);
    try {
      if (changed) await onSave(viewport);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  }

  async function exportProject(): Promise<void> {
    setError(undefined);
    try {
      await onExport();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <ProjectSettingsDialogFrame busy={saving || exporting} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <section className="project-settings-project" aria-label={t("projectSettings.project")}>
          <span>{t("projectSettings.project")}</span>
          <strong title={project.name}>{project.name}</strong>
        </section>
        <fieldset
          className="project-settings-section"
          disabled={saving || exporting}
        >
          <legend>{t("storySettings.screenSize")}</legend>
          <p className="project-settings-hint">
            {canvasFormatSummary(viewport)}
          </p>
          <CanvasFormatOptions
            value={selection}
            disabled={saving || exporting}
            onChange={setSelection}
          />
          {changed && graph.nodes.length > 0 ? (
            <p className="project-settings-hint">
              {t("storySettings.reviewScenes")}
            </p>
          ) : null}
        </fieldset>
        <fieldset className="project-settings-section" aria-label={t("storySettings.variables")}>
          <legend className="project-settings-section-heading">
            {t("storySettings.variables")}
            <button
              className="icon-button project-settings-help"
              type="button"
              aria-label={t("storySettings.aboutVariables")}
              aria-description={variablesHelp}
              data-tooltip={variablesHelp}
              disabled={saving || exporting}
            >
              <CircleHelp size={14} aria-hidden="true" />
            </button>
          </legend>
          {names.length ? (
            <ul className="playable-variables" aria-label={t("storySettings.variables")}>
              {names.map((name) => (
                <li key={name}>
                  <div className="playable-variables-head">
                    <strong>{name}</strong>
                    <span title={formatStateValue(graph.initialState[name])}>
                      {t("storySettings.starts", { value: describePlayableValue(graph.initialState[name]!) })}
                    </span>
                  </div>
                  {graph.variables?.[name] ? (
                    <p>{graph.variables[name]}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="playable-variables-empty">
              {t("storySettings.noVariables")}
            </p>
          )}
        </fieldset>
        <fieldset className="project-settings-section">
          <legend>{t("storySettings.export")}</legend>
          {changed ? (
            <p className="project-settings-hint">
              {t("storySettings.saveBeforeExport")}
            </p>
          ) : null}
          <button
            className="project-settings-browser"
            type="button"
            disabled={!canExport || saving || exporting || changed}
            onClick={() => void exportProject()}
          >
            {exporting ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Download size={14} />
            )}
            {exporting ? t("storySettings.exporting") : t("storySettings.exportGame")}
          </button>
        </fieldset>
        {error ? (
          <p className="project-settings-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <button
            type="button"
            disabled={saving || exporting}
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            className="project-settings-submit"
            type="submit"
            disabled={saving || exporting}
          >
            {saving ? <LoaderCircle className="spin" size={14} /> : null}
            {t("common.save")}
          </button>
        </footer>
      </form>
    </ProjectSettingsDialogFrame>
  );
}
