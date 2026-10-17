import { protocolOperations } from "../shared/model3d-operations.js";
import { useState } from "react";
import {
  IMAGE_ASPECT_RATIOS, IMAGE_MAX_REFERENCE_IMAGES, IMAGE_RESOLUTIONS, IMAGE_OUTPUT_COUNTS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS,
  type CustomModel3DSettings, type CustomModelUsages, type CustomProviderPreset, type ImageProtocol, type VideoProtocol,
} from "../shared/contracts.js";
import { defaultImageSettings, defaultModel3DSettings, defaultVideoSettings, IMAGE_PROTOCOL_LABELS, VIDEO_PROTOCOL_LABELS } from "../shared/custom-models.js";
import { knownImageReferenceLimit } from "../shared/image-reference-limits.js";
import { t } from "./i18n.js";

export function CustomModelUsageFields({ usages, preset, modelId, onChange }: {
  usages: CustomModelUsages; preset?: CustomProviderPreset; modelId: string; onChange: (usages: CustomModelUsages) => void;
}) {
  function toggle(usage: keyof CustomModelUsages, enabled: boolean) {
    const next = { ...usages };
    if (!enabled) delete next[usage];
    else if (usage === "language") next.language = true;
    else if (usage === "image") next.image = defaultImageSettings(preset === "google" ? "gemini-generate-content" : preset === "openrouter" ? "openrouter-images" : preset === "seedance" ? "volcengine-images" : "openai-images", modelId);
    else if (usage === "video") next.video = defaultVideoSettings(preset === "seedance" ? "seedance" : "openrouter-videos");
    else next["3d"] = defaultModel3DSettings("standard", preset === "tripo" ? "tripo" : preset === "hyper3d" ? "hyper3d" : "meshy");
    onChange(next);
  }
  const image = usages.image;
  const referenceDefault = knownImageReferenceLimit(modelId);
  const video = usages.video;
  const model3d = usages["3d"];
  return <>
    <fieldset className="custom-model-uses"><legend>{t("modelUsage.useFor")}</legend>
      <div className="custom-provider-capabilities">{(["language", "image", "video", "3d"] as const).map((usage) => <label key={usage}>
        <input type="checkbox" checked={Boolean(usages[usage])} onChange={(event) => toggle(usage, event.target.checked)} />{t(`capability.${usage}`)}
      </label>)}</div>
      {!Object.values(usages).some(Boolean) ? <small>{t("modelUsage.unassigned")}</small> : null}
    </fieldset>
    {image ? <div className="custom-model-use-settings">
      <label><span>{t("modelUsage.imageProtocol")}</span><select value={image.protocol} onChange={(event) => {
        const protocol = event.target.value as ImageProtocol;
        const resolutions = image.resolutions.filter((value) => value !== "512" || protocol === "gemini-generate-content" || protocol === "openrouter-images");
        onChange({ ...usages, image: { ...image, protocol, resolutions: resolutions.length ? resolutions : ["1K"] } });
      }}>
        {Object.entries(IMAGE_PROTOCOL_LABELS).map(([protocol, label]) => <option key={protocol} value={protocol}>{label}</option>)}
      </select></label>
      <details className="custom-provider-advanced"><summary>{t("modelUsage.imageSettings")}</summary>
        <EndpointField value={image.baseUrl} onChange={(baseUrl) => onChange({ ...usages, image: { ...image, baseUrl } })} />
        <ChoiceFields label={t("modelUsage.imageResolutions")} options={IMAGE_RESOLUTIONS.filter((value) => value !== "512" || image.protocol === "gemini-generate-content" || image.protocol === "openrouter-images")} value={image.resolutions} onChange={(resolutions) => onChange({ ...usages, image: { ...image, resolutions } })} />
        <ChoiceFields label={t("modelUsage.imageAspectRatios")} options={IMAGE_ASPECT_RATIOS} value={image.aspectRatios} onChange={(aspectRatios) => onChange({ ...usages, image: { ...image, aspectRatios } })} />
        <div className="project-settings-field-row">
          <NumberField label={t("modelUsage.maxReferenceImages")} value={image.maxReferenceImages} min={0} max={IMAGE_MAX_REFERENCE_IMAGES} onChange={(maxReferenceImages) => onChange({ ...usages, image: { ...image, maxReferenceImages } })} />
          <label><span>{t("modelUsage.maxOutputs")}</span><select value={image.maxOutputs} onChange={(event) => onChange({ ...usages, image: { ...image, maxOutputs: Number(event.target.value) as typeof image.maxOutputs } })}>{IMAGE_OUTPUT_COUNTS.map((count) => <option key={count}>{count}</option>)}</select></label>
        </div>
        {referenceDefault !== undefined && referenceDefault !== image.maxReferenceImages ? <button className="settings-secondary-button" type="button" onClick={() => onChange({ ...usages, image: { ...image, maxReferenceImages: referenceDefault } })}>{t("modelUsage.useReferenceDefault", { count: referenceDefault })}</button> : null}
      </details>
    </div> : null}
    {video ? <div className="custom-model-use-settings">
      <label><span>{t("modelUsage.videoProtocol")}</span><select value={video.protocol} onChange={(event) => onChange({ ...usages, video: { ...video, protocol: event.target.value as VideoProtocol } })}>
        {Object.entries(VIDEO_PROTOCOL_LABELS).map(([protocol, label]) => <option key={protocol} value={protocol}>{label}</option>)}
      </select></label>
      <details className="custom-provider-advanced"><summary>{t("modelUsage.videoSettings")}</summary>
        <EndpointField value={video.baseUrl} onChange={(baseUrl) => onChange({ ...usages, video: { ...video, baseUrl } })} />
        <ChoiceFields label={t("modelUsage.videoResolutions")} options={VIDEO_RESOLUTIONS} value={video.resolutions} onChange={(resolutions) => onChange({ ...usages, video: { ...video, resolutions } })} />
        <ChoiceFields label={t("modelUsage.videoAspectRatios")} options={VIDEO_ASPECT_RATIOS} value={video.aspectRatios} onChange={(aspectRatios) => onChange({ ...usages, video: { ...video, aspectRatios } })} />
        <NumberListField label={t("modelUsage.durations")} value={video.durations} onChange={(durations) => onChange({ ...usages, video: { ...video, durations } })} />
        <NumberField label={t("modelUsage.maxVideoReferences")} value={video.maxReferenceImages} min={0} max={30} onChange={(maxReferenceImages) => onChange({ ...usages, video: { ...video, maxReferenceImages } })} />
        <ChoiceFields label={t("modelUsage.videoReferenceModes")} options={["frame", "reference"] as const} labels={{ frame: t("modelUsage.referenceMode.frame"), reference: t("modelUsage.referenceMode.reference") }} value={video.referenceModes} onChange={(referenceModes) => onChange({ ...usages, video: { ...video, referenceModes } })} />
      </details>
    </div> : null}
    {model3d ? <Model3DSettingsFields value={model3d} onChange={(settings) => onChange({ ...usages, "3d": settings })} /> : null}
  </>;
}

export function Model3DSettingsFields({ value, onChange, lockCapabilities = false, lockProtocol = false, showEndpoint = true }: {
  value: CustomModel3DSettings; onChange: (value: CustomModel3DSettings) => void;
  lockCapabilities?: boolean; lockProtocol?: boolean; showEndpoint?: boolean;
}) {
  const limit = value.protocol === "hyper3d" ? 2_000_000 : value.protocol === "tripo" ? 1_500_000 : 300_000;
  const minimum = value.protocol === "hyper3d" ? 500 : value.protocol === "tripo" ? 48 : 100;
  const defaults = value.defaults ?? { texture: value.supportsTexture, pbr: false };
  function update(patch: Partial<CustomModel3DSettings>) {
    const next = { ...value, ...patch };
    const texture = next.supportsTexture && (next.defaults?.texture ?? next.supportsTexture);
    onChange({ ...next, defaults: { texture, pbr: texture && next.supportsPbr && (next.defaults?.pbr ?? false) } });
  }
  return <div className="custom-model-use-settings">
    {!lockProtocol ? <label><span>{t("modelUsage.model3dProtocol")}</span><select value={value.protocol} onChange={(event) => onChange({ ...defaultModel3DSettings("standard", event.target.value as typeof value.protocol), baseUrl: value.baseUrl })}><option value="meshy">Meshy</option><option value="tripo">Tripo V3</option><option value="hyper3d">Hyper3D Rodin</option></select></label> : null}
    <NumberField label={t("modelUsage.defaultPolycount")} value={value.polycount.default} min={value.polycount.min} max={value.polycount.max} onChange={(count) => update({ polycount: { ...value.polycount, default: count } })} />
    <NumberListField label={t("modelUsage.polycountPresets")} value={value.polycount.presets} onChange={(presets) => update({ polycount: { ...value.polycount, presets } })} />
    <fieldset className="custom-model-choices"><legend>{t("modelUsage.generationDefaults")}</legend><div className="custom-provider-capabilities">
      <label><input type="checkbox" checked={defaults.texture} disabled={!value.supportsTexture} onChange={(event) => update({ defaults: { texture: event.target.checked, pbr: event.target.checked && defaults.pbr } })} />{t("modelUsage.texture")}</label>
      <label><input type="checkbox" checked={defaults.pbr} disabled={!defaults.texture || !value.supportsPbr} onChange={(event) => update({ defaults: { ...defaults, pbr: event.target.checked } })} />PBR</label>
    </div></fieldset>
    <details className="custom-provider-advanced"><summary>{t("modelUsage.capabilities")}</summary>
      {lockCapabilities ? <p className="custom-provider-hint">{t("modelUsage.officialFixed")}</p> : <p className="custom-provider-hint">{t("modelUsage.matchDocs")}</p>}
      {showEndpoint ? <EndpointField value={value.baseUrl} onChange={(baseUrl) => update({ baseUrl })} /> : null}
      <fieldset disabled={lockCapabilities} className="custom-model-capability-fields">
        {value.protocol === "meshy" ? <label><span>{t("modelUsage.template")}</span><select value={value.operation} onChange={(event) => update({
          operation: event.target.value as typeof value.operation, maxReferenceImages: event.target.value === "image-to-3d" ? 1 : 4,
          modelType: event.target.value === "multi-image-to-3d" ? "standard" : value.modelType })}>
          <option value="image-to-3d">{t("modelUsage.singleImage")}</option><option value="multi-image-to-3d">{t("modelUsage.multiImage")}</option>
        </select></label> : null}
        {value.protocol === "meshy" ? <label><span>{t("modelUsage.topology")}</span><select value={value.modelType} onChange={(event) => {
          const settings = defaultModel3DSettings(event.target.value as typeof value.modelType);
          update({ modelType: settings.modelType, polycount: settings.polycount,
            ...(settings.modelType === "smart-topology" ? { operation: settings.operation, maxReferenceImages: 1 } : {}) });
        }}><option value="standard">{t("modelUsage.standard")}</option><option value="smart-topology">{t("modelUsage.smartTopology")}</option></select></label> : <p className="custom-provider-hint">{value.protocol === "tripo" ? t("modelUsage.tripoViews") : t("modelUsage.rodinViews")}</p>}
        <NumberField label={t("modelUsage.max3dReferences")} value={value.maxReferenceImages} min={1} max={value.operation === "image-to-3d" ? 1 : value.protocol === "hyper3d" ? 5 : 4} onChange={(maxReferenceImages) => update({ maxReferenceImages })} />
        <div className="project-settings-field-row">
          <NumberField label={t("modelUsage.minPolycount")} value={value.polycount.min} min={minimum} max={limit} onChange={(min) => update({ polycount: { ...value.polycount, min } })} />
          <NumberField label={t("modelUsage.maxPolycount")} value={value.polycount.max} min={value.polycount.min} max={limit} onChange={(max) => update({ polycount: { ...value.polycount, max } })} />
        </div>
        <div className="custom-provider-capabilities">
          <label><input type="checkbox" checked={value.supportsTexture} onChange={(event) => update({ supportsTexture: event.target.checked, supportsPbr: event.target.checked && value.supportsPbr })} />{t("modelUsage.textureSupport")}</label>
          <label><input type="checkbox" checked={value.supportsPbr} disabled={!value.supportsTexture} onChange={(event) => update({ supportsPbr: event.target.checked })} />{t("modelUsage.pbrSupport")}</label>
        </div>
        {!lockCapabilities ? <ChoiceFields label={t("modelUsage.operations")} options={protocolOperations(value.protocol).filter((operation) => operation !== "image")} labels={Object.fromEntries(protocolOperations(value.protocol).map((operation) => [operation, t(`assetCanvas.op.${operation}`)]))} value={value.operations ?? []} onChange={(operations) => update({ operations })} /> : null}
      </fieldset>
    </details>
  </div>;
}

function EndpointField({ value, onChange }: { value?: string; onChange: (value: string | undefined) => void }) {
  return <label><span>{t("modelUsage.baseUrlOverride")}</span><input type="url" value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)} placeholder={t("customProvider.useProviderBaseUrl")} autoComplete="off" spellCheck={false} /><small>{t("modelUsage.baseUrlBlank")}</small></label>;
}
function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" min={min} max={max} step={1} value={Number.isNaN(value) ? "" : value} onChange={(event) => onChange(event.target.value === "" ? NaN : Number(event.target.value))} /></label>;
}
function NumberListField({ label, value, onChange }: { label: string; value: readonly number[]; onChange: (value: number[]) => void }) {
  const [draft, setDraft] = useState<{ text: string; values: number[] }>();
  const text = draft && draft.values.length === value.length && draft.values.every((item, index) => Object.is(item, value[index])) ? draft.text : value.join(", ");
  return <label><span>{label}</span><input value={text} onChange={(event) => {
    const text = event.target.value;
    const values = text.trim() ? text.split(",").map((value) => value.trim() ? Number(value) : NaN) : [];
    setDraft({ text, values });
    onChange(values);
  }} /><small>{t("modelUsage.commas")}</small></label>;
}
function ChoiceFields<T extends string>({ label, options, labels, value, onChange }: { label: string; options: readonly T[]; labels?: Partial<Record<T, string>>; value: readonly T[]; onChange: (value: T[]) => void }) {
  return <fieldset className="custom-model-choices"><legend>{label}</legend><div className="custom-provider-capabilities">{options.map((option) => <label key={option}><input type="checkbox" checked={value.includes(option)} onChange={(event) => onChange(event.target.checked ? [...value, option] : value.filter((item) => item !== option))} />{labels?.[option] ?? option}</label>)}</div></fieldset>;
}
