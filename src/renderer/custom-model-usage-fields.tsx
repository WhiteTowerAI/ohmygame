import { useState } from "react";
import {
  IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS, IMAGE_OUTPUT_COUNTS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS,
  type CustomModel3DSettings, type CustomModelUsages, type CustomProviderPreset, type ImageProtocol, type VideoProtocol,
} from "../shared/contracts.js";
import { defaultImageSettings, defaultModel3DSettings, defaultVideoSettings, IMAGE_PROTOCOL_LABELS, MODEL_USAGE_LABELS, VIDEO_PROTOCOL_LABELS } from "../shared/custom-models.js";

export function CustomModelUsageFields({ usages, preset, onChange }: {
  usages: CustomModelUsages; preset?: CustomProviderPreset; onChange: (usages: CustomModelUsages) => void;
}) {
  function toggle(usage: keyof CustomModelUsages, enabled: boolean) {
    const next = { ...usages };
    if (!enabled) delete next[usage];
    else if (usage === "language") next.language = true;
    else if (usage === "image") next.image = defaultImageSettings(preset === "google" ? "gemini-generate-content" : preset === "openrouter" ? "openrouter-images" : preset === "seedance" ? "volcengine-images" : "openai-images");
    else if (usage === "video") next.video = defaultVideoSettings(preset === "seedance" ? "seedance" : "openrouter-videos");
    else next["3d"] = defaultModel3DSettings("standard", preset === "tripo" ? "tripo" : preset === "hyper3d" ? "hyper3d" : "meshy");
    onChange(next);
  }
  const image = usages.image;
  const video = usages.video;
  const model3d = usages["3d"];
  return <>
    <fieldset className="custom-model-uses"><legend>Use this model for</legend>
      <div className="custom-provider-capabilities">{(["language", "image", "video", "3d"] as const).map((usage) => <label key={usage}>
        <input type="checkbox" checked={Boolean(usages[usage])} onChange={(event) => toggle(usage, event.target.checked)} />{MODEL_USAGE_LABELS[usage]}
      </label>)}</div>
      {!Object.values(usages).some(Boolean) ? <small>Unassigned — choose a use before enabling this model.</small> : null}
    </fieldset>
    {image ? <div className="custom-model-use-settings">
      <label><span>Image protocol</span><select value={image.protocol} onChange={(event) => {
        const protocol = event.target.value as ImageProtocol;
        const resolutions = image.resolutions.filter((value) => value !== "512" || protocol === "gemini-generate-content" || protocol === "openrouter-images");
        onChange({ ...usages, image: { ...image, protocol, resolutions: resolutions.length ? resolutions : ["1K"] } });
      }}>
        {Object.entries(IMAGE_PROTOCOL_LABELS).map(([protocol, label]) => <option key={protocol} value={protocol}>{label}</option>)}
      </select></label>
      <details className="custom-provider-advanced"><summary>Image settings</summary>
        <EndpointField value={image.baseUrl} onChange={(baseUrl) => onChange({ ...usages, image: { ...image, baseUrl } })} />
        <ChoiceFields label="Image resolutions" options={IMAGE_RESOLUTIONS.filter((value) => value !== "512" || image.protocol === "gemini-generate-content" || image.protocol === "openrouter-images")} value={image.resolutions} onChange={(resolutions) => onChange({ ...usages, image: { ...image, resolutions } })} />
        <ChoiceFields label="Image aspect ratios" options={IMAGE_ASPECT_RATIOS} value={image.aspectRatios} onChange={(aspectRatios) => onChange({ ...usages, image: { ...image, aspectRatios } })} />
        <div className="project-settings-field-row">
          <NumberField label="Max reference images" value={image.maxReferenceImages} min={0} max={14} onChange={(maxReferenceImages) => onChange({ ...usages, image: { ...image, maxReferenceImages } })} />
          <label><span>Max outputs</span><select value={image.maxOutputs} onChange={(event) => onChange({ ...usages, image: { ...image, maxOutputs: Number(event.target.value) as typeof image.maxOutputs } })}>{IMAGE_OUTPUT_COUNTS.map((count) => <option key={count}>{count}</option>)}</select></label>
        </div>
      </details>
    </div> : null}
    {video ? <div className="custom-model-use-settings">
      <label><span>Video protocol</span><select value={video.protocol} onChange={(event) => onChange({ ...usages, video: { ...video, protocol: event.target.value as VideoProtocol } })}>
        {Object.entries(VIDEO_PROTOCOL_LABELS).map(([protocol, label]) => <option key={protocol} value={protocol}>{label}</option>)}
      </select></label>
      <details className="custom-provider-advanced"><summary>Video settings</summary>
        <EndpointField value={video.baseUrl} onChange={(baseUrl) => onChange({ ...usages, video: { ...video, baseUrl } })} />
        <ChoiceFields label="Video resolutions" options={VIDEO_RESOLUTIONS} value={video.resolutions} onChange={(resolutions) => onChange({ ...usages, video: { ...video, resolutions } })} />
        <ChoiceFields label="Video aspect ratios" options={VIDEO_ASPECT_RATIOS} value={video.aspectRatios} onChange={(aspectRatios) => onChange({ ...usages, video: { ...video, aspectRatios } })} />
        <NumberListField label="Durations in seconds" value={video.durations} onChange={(durations) => onChange({ ...usages, video: { ...video, durations } })} />
        <NumberField label="Max video reference images" value={video.maxReferenceImages} min={0} max={30} onChange={(maxReferenceImages) => onChange({ ...usages, video: { ...video, maxReferenceImages } })} />
        <ChoiceFields label="Video reference modes" options={["frame", "reference"] as const} value={video.referenceModes} onChange={(referenceModes) => onChange({ ...usages, video: { ...video, referenceModes } })} />
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
  const minimum = value.protocol === "hyper3d" ? 500 : 100;
  const defaults = value.defaults ?? { texture: value.supportsTexture, pbr: false };
  function update(patch: Partial<CustomModel3DSettings>) {
    const next = { ...value, ...patch };
    const texture = next.supportsTexture && (next.defaults?.texture ?? next.supportsTexture);
    onChange({ ...next, defaults: { texture, pbr: texture && next.supportsPbr && (next.defaults?.pbr ?? false) } });
  }
  return <div className="custom-model-use-settings">
    {!lockProtocol ? <label><span>3D protocol</span><select value={value.protocol} onChange={(event) => onChange({ ...defaultModel3DSettings("standard", event.target.value as typeof value.protocol), baseUrl: value.baseUrl })}><option value="meshy">Meshy</option><option value="tripo">Tripo V3</option><option value="hyper3d">Hyper3D Rodin</option></select></label> : null}
    <NumberField label="Default polycount" value={value.polycount.default} min={value.polycount.min} max={value.polycount.max} onChange={(count) => update({ polycount: { ...value.polycount, default: count } })} />
    <NumberListField label="Polycount presets" value={value.polycount.presets} onChange={(presets) => update({ polycount: { ...value.polycount, presets } })} />
    <fieldset className="custom-model-choices"><legend>Generation defaults</legend><div className="custom-provider-capabilities">
      <label><input type="checkbox" checked={defaults.texture} disabled={!value.supportsTexture} onChange={(event) => update({ defaults: { texture: event.target.checked, pbr: event.target.checked && defaults.pbr } })} />Texture</label>
      <label><input type="checkbox" checked={defaults.pbr} disabled={!defaults.texture || !value.supportsPbr} onChange={(event) => update({ defaults: { ...defaults, pbr: event.target.checked } })} />PBR</label>
    </div></fieldset>
    <details className="custom-provider-advanced"><summary>Model capabilities</summary>
      {lockCapabilities ? <p className="custom-provider-hint">Official capabilities are fixed. Add a custom version to configure a different model.</p> : <p className="custom-provider-hint">Match these limits to your provider's documentation. Local settings do not change upstream capabilities.</p>}
      {showEndpoint ? <EndpointField value={value.baseUrl} onChange={(baseUrl) => update({ baseUrl })} /> : null}
      <fieldset disabled={lockCapabilities} className="custom-model-capability-fields">
        {value.protocol === "meshy" ? <label><span>Generation template</span><select value={value.operation} onChange={(event) => update({
          operation: event.target.value as typeof value.operation, maxReferenceImages: event.target.value === "image-to-3d" ? 1 : 4,
          modelType: event.target.value === "multi-image-to-3d" ? "standard" : value.modelType })}>
          <option value="image-to-3d">Single image to 3D</option><option value="multi-image-to-3d">Multiple images to 3D</option>
        </select></label> : null}
        {value.protocol === "meshy" ? <label><span>Topology mode</span><select value={value.modelType} onChange={(event) => {
          const settings = defaultModel3DSettings(event.target.value as typeof value.modelType);
          update({ modelType: settings.modelType, polycount: settings.polycount,
            ...(settings.modelType === "smart-topology" ? { operation: settings.operation, maxReferenceImages: 1 } : {}) });
        }}><option value="standard">Standard</option><option value="smart-topology">Smart topology</option></select></label> : <p className="custom-provider-hint">{value.protocol === "tripo" ? "Views are ordered Front / Left / Back / Right. One image uses single-view generation." : "Rodin accepts up to five reference images. No fixed view order is required."}</p>}
        <NumberField label="Max 3D reference images" value={value.maxReferenceImages} min={1} max={value.operation === "image-to-3d" ? 1 : value.protocol === "hyper3d" ? 5 : 4} onChange={(maxReferenceImages) => update({ maxReferenceImages })} />
        <div className="project-settings-field-row">
          <NumberField label="Minimum polycount" value={value.polycount.min} min={minimum} max={limit} onChange={(min) => update({ polycount: { ...value.polycount, min } })} />
          <NumberField label="Maximum polycount" value={value.polycount.max} min={value.polycount.min} max={limit} onChange={(max) => update({ polycount: { ...value.polycount, max } })} />
        </div>
        <div className="custom-provider-capabilities">
          <label><input type="checkbox" checked={value.supportsTexture} onChange={(event) => update({ supportsTexture: event.target.checked, supportsPbr: event.target.checked && value.supportsPbr })} />Texture support</label>
          <label><input type="checkbox" checked={value.supportsPbr} disabled={!value.supportsTexture} onChange={(event) => update({ supportsPbr: event.target.checked })} />PBR support</label>
        </div>
      </fieldset>
    </details>
  </div>;
}

function EndpointField({ value, onChange }: { value?: string; onChange: (value: string | undefined) => void }) {
  return <label><span>Base URL override</span><input type="url" value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)} placeholder="Use the provider's Base URL" autoComplete="off" spellCheck={false} /><small>Leave blank to use this provider's connection.</small></label>;
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
  }} /><small>Separate values with commas.</small></label>;
}
function ChoiceFields<T extends string>({ label, options, value, onChange }: { label: string; options: readonly T[]; value: readonly T[]; onChange: (value: T[]) => void }) {
  return <fieldset className="custom-model-choices"><legend>{label}</legend><div className="custom-provider-capabilities">{options.map((option) => <label key={option}><input type="checkbox" checked={value.includes(option)} onChange={(event) => onChange(event.target.checked ? [...value, option] : value.filter((item) => item !== option))} />{option}</label>)}</div></fieldset>;
}
