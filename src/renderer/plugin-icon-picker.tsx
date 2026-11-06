import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  PLUGIN_ICON_MEDIA_TYPES,
  PLUGIN_ICON_MAX_BYTES,
} from "../shared/plugin-icons.js";
import type { PluginDraftPlugin, PluginIconChange } from "../shared/plugin-setup.js";
import { PluginGlyph } from "./plugin-icons.js";
import { Upload } from "./icons.js";
import { t } from "./i18n.js";
import { Button, Dialog } from "./ui/index.js";

const ICON_FILE = /\.(png|webp|svg)$/i;

/** What the icon will be: an image to upload, or one already in the package. */
type Choice = { type: "upload"; file: File } | { type: "asset"; path: string };

/** A manifest path and a package file name the same image with and without `./`. */
const packagePath = (path: string) => path.replace(/^\.\//, "");

/**
 * Picks a plugin's icon from the images in its package, or from one uploaded
 * into it. Every choice is a tile, so there's no path to type.
 */
export function PluginIconPicker({
  plugin,
  setupId,
  files,
  disabled,
  onClose,
  onSave,
}: {
  plugin: PluginDraftPlugin;
  setupId: string;
  files: readonly { path: string }[];
  disabled: boolean;
  onClose: () => void;
  onSave: (change: PluginIconChange) => Promise<void>;
}) {
  const current = plugin.icon?.type === "asset" ? packagePath(plugin.icon.path) : undefined;
  const images = files.map(entry => entry.path).filter(path => ICON_FILE.test(path));
  const [choice, setChoice] = useState<Choice | undefined>(current ? { type: "asset", path: current } : undefined);
  const [upload, setUpload] = useState<{ file: File; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  pending.current = busy || disabled;
  useEffect(() => () => { if (upload) URL.revokeObjectURL(upload.url); }, [upload]);

  function choose(file: File | undefined) {
    setError(undefined);
    if (!file) return;
    if (!ICON_FILE.test(file.name) || file.size > PLUGIN_ICON_MAX_BYTES || !file.size) {
      setError(t("pluginIconPicker.invalidFile"));
      return;
    }
    setUpload({ file, url: URL.createObjectURL(file) });
    setChoice({ type: "upload", file });
  }

  async function save(change: PluginIconChange) {
    if (pending.current) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(change);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveChoice() {
    if (!choice) return;
    if (choice.type === "asset") return save({ icon: { type: "asset", path: `./${choice.path}` } });
    const { file } = choice;
    let data: string;
    try {
      data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error(t("pluginIconPicker.readFailed")));
        reader.readAsDataURL(file);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const extension = file.name.toLowerCase().split(".").at(-1) as keyof typeof PLUGIN_ICON_MEDIA_TYPES;
    return save({ image: { data, mediaType: PLUGIN_ICON_MEDIA_TYPES[extension] } });
  }

  const locked = busy || disabled;
  const tile = (selected: boolean, label: string, glyph: ReactNode, onSelect: () => void, key: string) =>
    <button key={key} type="button" className="plugin-icon-tile" aria-pressed={selected} title={label} disabled={locked} onClick={onSelect}>
      <span className="plugin-icon-tile-image">{glyph}</span>
      <span className="plugin-icon-tile-name">{label}</span>
    </button>;

  return <Dialog open size="sm" onClose={() => { if (!pending.current) onClose(); }}
    title={t("pluginIconPicker.title")} description={plugin.displayName}
    footer={<>
      <Button variant="ghost" className="plugin-icon-default" disabled={locked} onClick={() => void save({ icon: null })}>{t("pluginIconPicker.useDefault")}</Button>
      <Button disabled={locked} onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="primary" disabled={locked || !choice} onClick={() => void saveChoice()}>
        {busy ? t("common.saving") : t("pluginIconPicker.save")}
      </Button>
    </>}>
    <div className="plugin-icon-picker">
      <div className="plugin-icon-grid" role="group" aria-label={t("pluginIconPicker.source")}>
        <label className={`plugin-icon-tile plugin-icon-upload${locked ? " is-disabled" : ""}`}>
          <input className="visually-hidden" type="file" aria-label={t("pluginIconPicker.imageInput")} disabled={locked}
            accept="image/png,image/webp,image/svg+xml,.png,.webp,.svg"
            onChange={event => { choose(event.target.files?.[0]); event.target.value = ""; }} />
          <span className="plugin-icon-tile-image"><Upload size={18} aria-hidden="true" /></span>
          <span className="plugin-icon-tile-name">{t("pluginIconPicker.upload")}</span>
        </label>
        {upload ? tile(choice?.type === "upload", upload.file.name,
          <img src={upload.url} width={32} height={32} alt="" className="plugin-icon-image" />,
          () => setChoice({ type: "upload", file: upload.file }), "upload") : null}
        {images.map(path => tile(choice?.type === "asset" && choice.path === path, path.split("/").at(-1)!,
          <PluginGlyph plugin={{ id: plugin.id, icon: { type: "asset", path: `./${path}` } }} size={32} setupId={setupId} previewAsset />,
          () => setChoice({ type: "asset", path }), path))}
      </div>
      <p className="plugin-icon-help">{t("pluginIconPicker.fileHelp")}</p>
      {error ? <p className="plugin-builder-error" role="alert">{error}</p> : null}
    </div>
  </Dialog>;
}
