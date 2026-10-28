import { useState } from "react";
import { LoaderCircle, Pencil } from "./icons.js";
import effectLibraryCover from "./assets/templates/examples/effect-library-cover.webp";
import { TemplateDemo } from "./asset-canvas-template-showcase.js";
import {
  ASSET_CANVAS_TEMPLATES,
  createEffectLibraryProject,
  createAssetCanvasTemplateProject,
  type AssetCanvasTemplate,
} from "./asset-canvas-templates.js";
import { t } from "./i18n.js";

export function AssetCanvasTemplateLauncher({
  onOpenProject,
}: {
  onOpenProject: (projectId: string, nodeId?: string) => void;
}) {
  const [creating, setCreating] = useState<AssetCanvasTemplate | "effect-library">();
  const [error, setError] = useState<string>();

  async function open(template: AssetCanvasTemplate) {
    if (creating) return;
    setCreating(template);
    setError(undefined);
    try {
      const project = await createAssetCanvasTemplateProject(template);
      onOpenProject(project.projectId, project.nodeId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(undefined);
    }
  }

  async function openEffectLibrary() {
    if (creating) return;
    setCreating("effect-library");
    setError(undefined);
    try {
      const project = await createEffectLibraryProject();
      onOpenProject(project.projectId, project.nodeId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(undefined);
    }
  }

  return (
    <section
      className="home-discover home-explore studio-examples asset-template-launcher"
      aria-labelledby="asset-template-heading"
    >
      <div className="studio-section-heading">
        <h2 id="asset-template-heading">{t("assetCanvasTemplates.heading")}</h2>
      </div>
      <div className="home-whats-new-grid">
        {ASSET_CANVAS_TEMPLATES.map((template) => (
          <div className="home-explore-card" key={template}>
            <button
              className="home-whats-new-item"
              type="button"
              disabled={creating !== undefined}
              aria-busy={creating === template}
              onClick={() => void open(template)}
            >
              <span
                className="home-whats-new-icon home-explore-cover asset-template-cover"
                aria-hidden="true"
              >
                <TemplateDemo template={template} />
                <span className="home-explore-play">
                  {creating === template ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Pencil size={14} />
                  )}
                  {t("assetCanvasTemplates.openCanvas")}
                </span>
              </span>
              <span className="home-whats-new-copy">
                <strong>{t(`assetCanvasTemplates.${template}.title`)}</strong>
              </span>
            </button>
          </div>
        ))}
        <div className="home-explore-card">
          <button
            className="home-whats-new-item"
            type="button"
            disabled={creating !== undefined}
            aria-busy={creating === "effect-library"}
            onClick={() => void openEffectLibrary()}
          >
            <span
              className="home-whats-new-icon home-explore-cover asset-effect-library-cover"
              aria-hidden="true"
            >
              <img src={effectLibraryCover} alt="" draggable={false} />
              <span className="home-explore-play">
                {creating === "effect-library" ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Pencil size={14} />
                )}
                {t("assetCanvasTemplates.openCanvas")}
              </span>
            </span>
            <span className="home-whats-new-copy">
              <strong>{t("effectLibrary.title")}</strong>
            </span>
          </button>
        </div>
      </div>
      {error ? (
        <p className="home-notice" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
