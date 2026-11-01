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
import { CanvasFormatOptions } from "./canvas-format-options.js";
import { LoaderCircle } from "./icons.js";
import { ProjectSettingsDialogFrame } from "./project-settings-dialog.js";
import { Button } from "./ui/index.js";
import { ProjectAppearanceSettings } from "./project-appearance-settings.js";
import { t } from "./i18n.js";

export function PlayableProjectSettingsDialog({
  project,
  graph,
  onSave,
  onClose,
}: {
  project: ProjectState;
  graph: NodeGraph;
  onSave: (viewport: Viewport) => Promise<void>;
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

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
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

  return (
    <ProjectSettingsDialogFrame busy={saving} onClose={onClose}>
      <form className="project-settings-form" onSubmit={(event) => void submit(event)}>
        <div className="ui-dialog-body">
        <section className="project-settings-project" aria-label={t("projectSettings.project")}>
          <span>{t("projectSettings.project")}</span>
          <strong title={project.name}>{project.name}</strong>
        </section>
        <ProjectAppearanceSettings project={project} disabled={saving} />
        <fieldset
          className="project-settings-section"
          disabled={saving}
        >
          <legend>{t("storySettings.screenSize")}</legend>
          <p className="project-settings-hint">
            {canvasFormatSummary(viewport)}
          </p>
          <CanvasFormatOptions
            value={selection}
            disabled={saving}
            onChange={setSelection}
          />
          {changed && graph.nodes.length > 0 ? (
            <p className="project-settings-hint">
              {t("storySettings.reviewScenes")}
            </p>
          ) : null}
        </fieldset>
        {error ? (
          <p className="project-settings-error" role="alert">
            {error}
          </p>
        ) : null}
        </div>
        <div className="ui-dialog-footer">
          <Button disabled={saving} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={saving}
            icon={saving ? <LoaderCircle className="spin" size={14} /> : undefined}
          >
            {t("common.save")}
          </Button>
        </div>
      </form>
    </ProjectSettingsDialogFrame>
  );
}
