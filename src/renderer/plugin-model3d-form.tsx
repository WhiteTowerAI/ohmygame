import { useState, type FormEvent } from "react";
import { MODEL_3D_MIN_POLYCOUNT } from "../shared/contracts.js";
import {
  pluginMediaModelProblem,
  type PluginEditable3DModel,
  type PluginMediaModelList,
  type PluginMediaModels,
  type PluginSave3DModel,
} from "../shared/plugin-manifest.js";
import {
  ChoiceFields,
  NumberField,
  NumberListField,
} from "./custom-model-usage-fields.js";
import { LoaderCircle } from "./icons.js";
import { t } from "./i18n.js";
import { Disclosure } from "./ui/index.js";

/** Keep omitted capabilities omitted; preset edits must not rewrite the adapter's contract. */
function editable(model: PluginMediaModels["3d"]): PluginEditable3DModel {
  const {
    id,
    title,
    operations,
    polycount,
    maxReferenceImages,
    texture,
    pbr,
    defaults,
    modelSettings,
  } = model;
  return {
    id,
    title,
    operations,
    polycount,
    maxReferenceImages,
    texture,
    pbr,
    defaults,
    modelSettings,
  };
}

export function PluginModel3DForm({
  editor,
  initial,
  busy,
  saveError,
  onSave,
  onCancel,
  onReset,
}: {
  editor: NonNullable<PluginMediaModelList["editor"]>;
  initial?: PluginMediaModelList["models"][number];
  busy: boolean;
  saveError?: string;
  onSave: (request: PluginSave3DModel) => void;
  onCancel: () => void;
  onReset?: () => void;
}) {
  const [template, setTemplate] = useState(editor.templates[0]?.id ?? "");
  const [model, setModel] = useState<PluginEditable3DModel>(() =>
    initial?.definition
      ? editable(initial.definition)
      : { ...editable(editor.templates[0]!), id: "", title: "" },
  );
  const [name, setName] = useState(initial?.name ?? "");
  const [error, setError] = useState<string>();
  const locked = Boolean(initial && !initial.custom);
  const texture = Boolean(model.texture && (model.defaults?.texture ?? true));
  const pbr = Boolean(texture && model.pbr && model.defaults?.pbr);
  function patch(values: Partial<PluginEditable3DModel>) {
    setModel((current) => ({ ...current, ...values }));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = {
      ...model,
      id: model.id.trim(),
      title: initial && name === initial.name ? model.title : name.trim(),
    };
    const base =
      initial?.definition ??
      editor.templates.find((item) => item.id === template)!;
    const complete = { ...base, ...value };
    if (!complete.title) delete complete.title;
    const problem = pluginMediaModelProblem("3d", complete);
    if (problem) {
      setError(problem);
      return;
    }
    setError(undefined);
    onSave({
      revision: editor.revision,
      ...(!initial ? { templateId: template } : {}),
      model: value,
    });
  }
  return (
    <form
      className="provider-model-form provider-model3d-form"
      aria-label={initial ? t("model3dForm.edit") : t("model3dForm.add")}
      onSubmit={submit}
    >
      <fieldset disabled={busy}>
        <div className="provider-model-form-grid">
          <label className="settings-detail-field">
            <span className="settings-search-field-label">
              {t("models.modelId")}
            </span>
            <input
              className="settings-search-input"
              value={model.id}
              disabled={Boolean(initial)}
              onChange={(event) => patch({ id: event.target.value })}
              placeholder={t("model3dForm.idPlaceholder")}
              maxLength={200}
              required
              autoFocus={!initial}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="settings-detail-field">
            <span className="settings-search-field-label">
              {t("models.displayName")}
            </span>
            <input
              className="settings-search-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={model.id || t("customProvider.sameAsId")}
              maxLength={200}
              autoFocus={Boolean(initial)}
            />
          </label>
        </div>
        {!initial ? (
          <label className="settings-detail-field">
            <span className="settings-search-field-label">
              {t("model3dForm.startFrom")}
            </span>
            <select
              className="settings-search-input"
              value={template}
              onChange={(event) => {
                setTemplate(event.target.value);
                setModel({
                  ...editable(
                    editor.templates.find(
                      (item) => item.id === event.target.value,
                    )!,
                  ),
                  id: model.id,
                  title: model.title,
                });
                setError(undefined);
              }}
            >
              {editor.templates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title ?? item.id}
                </option>
              ))}
            </select>
            <small>{t("model3dForm.templateHint")}</small>
          </label>
        ) : null}
        <div className="custom-model-use-settings">
          <NumberField
            label={t("modelUsage.defaultPolycount")}
            value={model.polycount.default}
            min={model.polycount.min}
            max={model.polycount.max}
            onChange={(count) =>
              patch({ polycount: { ...model.polycount, default: count } })
            }
          />
          <NumberListField
            label={t("modelUsage.polycountPresets")}
            value={model.polycount.presets ?? [model.polycount.default]}
            onChange={(presets) =>
              patch({ polycount: { ...model.polycount, presets } })
            }
          />
          <fieldset className="custom-model-choices">
            <legend>{t("modelUsage.generationDefaults")}</legend>
            <div className="custom-provider-capabilities">
              <label>
                <input
                  type="checkbox"
                  checked={texture}
                  disabled={!model.texture}
                  onChange={(event) =>
                    patch({
                      defaults: {
                        texture: event.target.checked,
                        pbr: event.target.checked && pbr,
                      },
                    })
                  }
                />
                {t("modelUsage.texture")}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={pbr}
                  disabled={!texture || !model.pbr}
                  onChange={(event) =>
                    patch({ defaults: { texture, pbr: event.target.checked } })
                  }
                />
                PBR
              </label>
            </div>
          </fieldset>
          <Disclosure
            className="custom-provider-advanced"
            summary={t("modelUsage.capabilities")}
          >
            <p className="custom-provider-hint">
              {locked
                ? t("modelUsage.officialFixed")
                : t("modelUsage.matchDocs")}
            </p>
            <fieldset
              disabled={locked}
              className="custom-model-capability-fields"
            >
              <ChoiceFields
                label={t("modelUsage.operations")}
                options={["text", "image"] as const}
                labels={{
                  text: t("assetCanvas.op.text"),
                  image: t("assetCanvas.op.image"),
                }}
                value={model.operations}
                onChange={(operations) => patch({ operations })}
              />
              {model.modelSettings ? (
                <>
                  <label>
                    <span>{t("modelUsage.template")}</span>
                    <select
                      value={model.modelSettings.imageOperation}
                      onChange={(event) =>
                        patch({
                          modelSettings: {
                            ...model.modelSettings!,
                            imageOperation: event.target.value as
                              "image-to-3d" | "multi-image-to-3d",
                            ...(event.target.value === "multi-image-to-3d"
                              ? { modelType: "standard" }
                              : {}),
                          },
                          ...(event.target.value === "image-to-3d"
                            ? { maxReferenceImages: 1 }
                            : {}),
                        })
                      }
                    >
                      <option value="image-to-3d">
                        {t("modelUsage.singleImage")}
                      </option>
                      <option value="multi-image-to-3d">
                        {t("modelUsage.multiImage")}
                      </option>
                    </select>
                  </label>
                  <label>
                    <span>{t("modelUsage.topology")}</span>
                    <select
                      value={model.modelSettings.modelType}
                      onChange={(event) =>
                        patch({
                          modelSettings: {
                            ...model.modelSettings!,
                            modelType: event.target.value as
                              "standard" | "smart-topology",
                            ...(event.target.value === "smart-topology"
                              ? { imageOperation: "image-to-3d" }
                              : {}),
                          },
                          ...(event.target.value === "smart-topology"
                            ? { maxReferenceImages: 1 }
                            : {}),
                        })
                      }
                    >
                      <option value="standard">
                        {t("modelUsage.standard")}
                      </option>
                      <option value="smart-topology">
                        {t("modelUsage.smartTopology")}
                      </option>
                    </select>
                  </label>
                </>
              ) : null}
              <NumberField
                label={t("modelUsage.max3dReferences")}
                value={model.maxReferenceImages ?? 1}
                min={1}
                max={
                  model.modelSettings?.imageOperation === "image-to-3d" ? 1 : 8
                }
                onChange={(maxReferenceImages) => patch({ maxReferenceImages })}
              />
              <div className="project-settings-field-row">
                <NumberField
                  label={t("modelUsage.minPolycount")}
                  value={model.polycount.min}
                  min={MODEL_3D_MIN_POLYCOUNT}
                  max={2_000_000}
                  onChange={(min) =>
                    patch({ polycount: { ...model.polycount, min } })
                  }
                />
                <NumberField
                  label={t("modelUsage.maxPolycount")}
                  value={model.polycount.max}
                  min={model.polycount.min}
                  max={2_000_000}
                  onChange={(max) =>
                    patch({ polycount: { ...model.polycount, max } })
                  }
                />
              </div>
              <div className="custom-provider-capabilities">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(model.texture)}
                    onChange={(event) =>
                      patch({
                        texture: event.target.checked,
                        pbr: event.target.checked && model.pbr,
                        defaults: {
                          texture: event.target.checked && texture,
                          pbr: event.target.checked && pbr,
                        },
                      })
                    }
                  />
                  {t("modelUsage.textureSupport")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(model.pbr)}
                    disabled={!model.texture}
                    onChange={(event) =>
                      patch({
                        pbr: event.target.checked,
                        defaults: { texture, pbr: event.target.checked && pbr },
                      })
                    }
                  />
                  {t("modelUsage.pbrSupport")}
                </label>
              </div>
            </fieldset>
          </Disclosure>
        </div>
      </fieldset>
      {error || saveError ? (
        <p className="settings-error" role="alert">
          {error ?? saveError}
        </p>
      ) : null}
      <div className="provider-model-form-footer">
        {onReset ? (
          <button
            className="settings-secondary-button"
            type="button"
            disabled={busy}
            onClick={onReset}
          >
            {t("model3dForm.restore")}
          </button>
        ) : (
          <span />
        )}
        <div className="provider-model-form-actions">
          <button
            className="settings-secondary-button"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          <button
            className="settings-primary-button"
            type="submit"
            disabled={busy || !model.id.trim()}
          >
            {busy ? <LoaderCircle className="spin" size={13} /> : null}
            {initial ? t("common.save") : t("common.add")}
          </button>
        </div>
      </div>
    </form>
  );
}
