import type { NodeProps } from "@xyflow/react";
import type { AssetCanvasFlowNode } from "./asset-canvas-flow.js";
import { OUTPUT_HANDLE } from "./asset-canvas-flow.js";
import { CanvasNodeLabel } from "./canvas-node-label.js";
import { CanvasComposer, CanvasPort } from "./canvas-node-interactions.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { ModelPreview } from "./model-preview.js";
import { ArrowUp, LoaderCircle, Plug, Square, X } from "./icons.js";
import { t } from "./i18n.js";
import { canvasNodeParamValue } from "../shared/canvas-plugin-nodes.js";
import type { ProjectCanvasNode } from "../shared/plugins.js";

// A node a plugin adds to the canvas: one row per input, each with its own
// port, the plugin's settings in the composer, and its one output.

export function PluginNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.pluginRuntime;
  const definition = runtime?.definition;
  const preview = useWorkspaceAssetUrl(undefined, "", 0, data.assetId);
  const values = data.params ?? {};
  const disabled = !definition || runtime?.busy === true;
  const missing = definition?.inputs.some((input) => !input.optional && !runtime?.sources[input.id]?.length) ?? true;
  const ran = Boolean(data.assetId || data.text !== undefined);
  const label = ran ? t("assetCanvas.plugin.runAgain") : t("assetCanvas.plugin.run");
  const set = (key: string, value: string | number | boolean) => runtime?.onChange({ ...values, [key]: value });
  // While its plugin is off the node keeps its ports, so its connections stay drawn, and its last output.
  const inputs: Array<{ id: string; title: string; accepts?: ProjectCanvasNode["output"]; optional?: boolean }> = definition?.inputs ?? Object.keys(data.inputs ?? {}).map((id) => ({ id, title: id }));
  const output = definition?.output ?? runtime?.output;
  const title = definition?.title ?? data.node?.slice(data.node.lastIndexOf(":") + 1) ?? "";
  return (
    <div className={`story-node story-plugin-node${selected ? " is-selected" : ""}`}>
      <CanvasNodeLabel icon={Plug} label={title} details={data.nodeDetails} trailing={definition ? <small>{definition.pluginName}</small> : undefined} />
      {inputs.length ? <div className="story-plugin-inputs">
        {inputs.map((input) => {
          const sources = runtime?.sources[input.id] ?? [];
          return <div key={input.id} className="story-plugin-input">
            <CanvasPort className="story-plugin-input-handle" id={input.id} type="target" />
            <span className="story-plugin-input-title">{input.title}{input.optional ? <small>{t("assetCanvas.plugin.optional")}</small> : null}</span>
            {sources.length ? sources.map((source, index) => <span key={`${source.nodeId ?? "library"}:${index}`} className="story-plugin-source">
              <span>{source.name}</span>
              <button className="nodrag" type="button" disabled={disabled} title={t("assetCanvas.plugin.removeInput", { name: source.name })} aria-label={t("assetCanvas.plugin.removeInput", { name: source.name })} onClick={() => runtime?.onRemoveInput(input.id, index)}><X size={11} /></button>
            </span>) : input.accepts ? <span className="story-plugin-empty">{t("assetCanvas.plugin.connect", { media: t(`assetCanvas.plugin.media.${input.accepts}`) })}</span> : null}
          </div>;
        })}
      </div> : null}
      <div data-alignment-frame className={`story-plugin-output${runtime?.generating ? " is-generating" : ""}`}>
        {runtime?.generating ? <div className="story-media-empty" role="status"><LoaderCircle className="spin" size={20} /><strong>{t("assetCanvas.plugin.running")}</strong></div>
          : data.text !== undefined ? <p className="story-plugin-text nowheel">{data.text}</p>
            : preview.url && output === "image" ? <img src={preview.url} alt={title} />
              : preview.url && output === "video" ? <video src={preview.url} controls muted className="nodrag" />
                : preview.url && output === "audio" ? <audio src={preview.url} controls className="nodrag" />
                  : preview.url && output === "model" ? <ModelPreview source={preview.url} label={title} minHeight={200} interactive={false} />
                    : !definition && !data.assetId ? null
                      : <div className="story-media-empty"><Plug size={28} /><span>{data.assetId ? t("assetCanvas.loadingAsset") : t("assetCanvas.plugin.noOutput")}</span></div>}
      </div>
      {!definition && runtime ? <p className="story-plugin-off">{t("assetCanvas.plugin.off")}</p> : null}
      {runtime?.error ? <p className="story-plugin-error" role="alert">{runtime.error}</p> : null}
      <CanvasPort className="story-plugin-output-handle" id={OUTPUT_HANDLE} type="source" />
      {data.panelOpen && definition ? <div className="canvas-node-auxiliary"><CanvasComposer className="story-media-composer story-plugin-composer nodrag nowheel">
        {definition.description ? <div className="story-plugin-description">{definition.description}</div> : null}
        {definition.params.length ? <div className="story-plugin-params" role="group" aria-label={t("assetCanvas.plugin.settings")}>
          {definition.params.map((param) => {
            const value = canvasNodeParamValue(param, Object.hasOwn(values, param.key) ? values[param.key] : undefined);
            return <label key={param.key} className={`story-plugin-param is-${param.type}`} title={param.description}>
              <span>{param.title}</span>
              {param.type === "boolean" ? <input className="nokey" type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => set(param.key, event.target.checked)} />
                : param.type === "select" ? <select className="nokey" value={String(value)} disabled={disabled} onChange={(event) => set(param.key, event.target.value)}>
                  {(param.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
                  : param.type === "number" ? <input className="nokey" type="number" value={String(value)} min={param.minimum} max={param.maximum} disabled={disabled} onChange={(event) => { if (event.target.value !== "") set(param.key, Number(event.target.value)); }} />
                    : <input className="nokey" type="text" value={String(value)} disabled={disabled} onChange={(event) => set(param.key, event.target.value)} />}
            </label>;
          })}
        </div> : null}
        <div className="story-media-controls">
          {runtime?.generating && runtime.onCancel
            ? <button type="button" title={t("assetCanvas.plugin.cancel")} aria-label={t("assetCanvas.plugin.cancel")} onClick={runtime.onCancel}><Square size={13} /></button>
            : <button type="button" title={label} aria-label={label} disabled={disabled || missing || runtime?.generating} onClick={runtime?.onGenerate}>
              {runtime?.generating ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
            </button>}
        </div>
      </CanvasComposer></div> : null}
    </div>
  );
}
