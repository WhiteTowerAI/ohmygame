import { useState, type FormEvent } from "react";
import type { Model3DDefinition } from "../shared/contracts.js";
import { MODEL_3D_PRESETS, model3DPreset, normalizeNativeModel3D, type Native3DProviderId } from "../shared/model3d-presets.js";
import { Model3DSettingsFields } from "./custom-model-usage-fields.js";
import { LoaderCircle } from "./icons.js";

export function ProviderModel3DForm({ protocol, initial, busy, onSave, onCancel, onReset }: {
  protocol: Native3DProviderId; initial?: Model3DDefinition; busy: boolean;
  onSave: (model: Model3DDefinition) => Promise<void>; onCancel: () => void; onReset?: () => void;
}) {
  const presets = MODEL_3D_PRESETS[protocol];
  const [template, setTemplate] = useState(presets[0]!.id);
  const [model, setModel] = useState<Model3DDefinition>(initial ?? { id: "", name: "", settings: presets[0]!.settings });
  const [error, setError] = useState<string>();
  const official = Boolean(initial && model3DPreset(protocol, initial.id));
  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const normalized = normalizeNativeModel3D(protocol, model);
      setError(undefined);
      void onSave(normalized);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <form className="provider-model-form provider-model3d-form" aria-label={initial ? "Edit 3D model" : "Add 3D model"} onSubmit={submit}>
    <fieldset disabled={busy}>
      <div className="provider-model-form-grid">
        <label className="settings-detail-field"><span className="settings-search-field-label">Model ID</span><input className="settings-search-input" value={model.id} disabled={Boolean(initial)} onChange={(event) => setModel({ ...model, id: event.target.value })} placeholder="Exact model version from your provider" maxLength={200} required autoFocus={!initial} autoComplete="off" spellCheck={false} /></label>
        <label className="settings-detail-field"><span className="settings-search-field-label">Display name</span><input className="settings-search-input" value={model.name} onChange={(event) => setModel({ ...model, name: event.target.value })} placeholder={model.id || "Same as model ID"} maxLength={200} /></label>
      </div>
      {!initial ? <label className="settings-detail-field"><span className="settings-search-field-label">Start from</span><select className="settings-search-input" value={template} onChange={(event) => {
        setTemplate(event.target.value);
        setModel({ ...model, settings: presets.find((preset) => preset.id === event.target.value)!.settings });
      }}>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><small>Copy a compatible template, then check its limits against the new version.</small></label> : null}
      <Model3DSettingsFields value={model.settings} onChange={(settings) => setModel({ ...model, settings })} lockProtocol lockCapabilities={official} showEndpoint={false} />
    </fieldset>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    <div className="provider-model-form-footer">
      {official && onReset ? <button className="settings-secondary-button" type="button" disabled={busy} onClick={onReset}>Restore defaults</button> : <span />}
      <div className="provider-model-form-actions">
        <button className="settings-secondary-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="settings-primary-button" type="submit" disabled={busy || !model.id.trim()}>{busy ? <LoaderCircle className="spin" size={13} /> : null}{initial ? "Save" : "Add"}</button>
      </div>
    </div>
  </form>;
}
