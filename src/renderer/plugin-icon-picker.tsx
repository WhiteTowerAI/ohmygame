import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  PLUGIN_ICON_MAX_BYTES,
  PLUGIN_ICON_PRESETS,
} from "../shared/plugin-icons.js";
import { isPluginIcon, type PluginDetail } from "../shared/plugins.js";
import type { PluginIconChange } from "../shared/plugin-setup.js";
import { PluginIcon, PLUGIN_PRESET_GLYPHS } from "./plugin-icons.js";
import { PluginFilePicker } from "./plugin-file-picker.js";
import { t } from "./i18n.js";

export function PluginIconPicker({
  plugin,
  setupId,
  files,
  disabled,
  onClose,
  onSave,
}: {
  plugin: PluginDetail;
  setupId: string;
  files: readonly { path: string }[];
  disabled: boolean;
  onClose: () => void;
  onSave: (change: PluginIconChange) => Promise<void>;
}) {
  const titleId = useId(),
    pathsId = useId();
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [mode, setMode] = useState<"preset" | "upload" | "path">(
    plugin.icon?.type === "asset" ? "path" : "preset",
  );
  const [search, setSearch] = useState("");
  const [presetId, setPresetId] = useState<string>(
    plugin.icon?.type === "preset" ? plugin.icon.id : "package",
  );
  const [assetPath, setAssetPath] = useState(
    plugin.icon?.type === "asset" ? plugin.icon.path : "",
  );
  const [file, setFile] = useState<File>();
  const [localImage, setLocalImage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  pending.current = busy || disabled;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!pending.current) close.current();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const elements = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled):not([tabindex='-1'])",
        ),
      ];
      const first = elements[0],
        last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        dialog.current.focus();
      } else if (
        !dialog.current.contains(document.activeElement) ||
        document.activeElement === dialog.current
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => {
      window.removeEventListener("keydown", keyboard, true);
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (!file) {
      setLocalImage(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setLocalImage(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const icon =
    mode === "preset"
      ? { type: "preset", id: presetId }
      : { type: "asset", path: assetPath.trim() };
  const valid = mode === "upload" ? Boolean(file) : isPluginIcon(icon);
  const preview = {
    ...plugin,
    icon: isPluginIcon(icon) ? icon : undefined,
    iconRevision: undefined,
  };
  async function save(change?: PluginIconChange) {
    if (pending.current) return;
    setBusy(true);
    setError(undefined);
    try {
      if (!change) {
        if (mode === "upload" && file) {
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () =>
              reject(new Error(t("pluginIconPicker.readFailed")));
            reader.readAsDataURL(file);
          });
          change = {
            image: {
              data,
              mediaType: file.name.toLowerCase().endsWith(".webp")
                ? "image/webp"
                : "image/png",
            },
          };
        } else if (isPluginIcon(icon)) change = { icon };
      }
      if (!change) throw new Error(t("pluginIconPicker.chooseIcon"));
      await onSave(change);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const matches = PLUGIN_ICON_PRESETS.filter((item) =>
    `${item.id} ${item.label} ${t(`pluginIcons.${item.id}`)} ${item.keywords}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return createPortal(
    <div
      className="plugin-install-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending.current) onClose();
      }}
    >
      <section
        ref={dialog}
        className="plugin-install-dialog plugin-icon-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="plugin-icon-picker-heading">
          {mode === "upload" && localImage ? (
            <span className="plugin-row-icon">
              <img
                className="plugin-icon-image"
                src={localImage}
                width={36}
                height={36}
                alt={t("pluginIconPicker.preview")}
              />
            </span>
          ) : (
            <PluginIcon
              plugin={preview}
              setupId={setupId}
              previewAsset={mode === "path"}
            />
          )}
          <div>
            <h2 id={titleId}>{t("pluginIconPicker.title")}</h2>
            <p>{plugin.displayName}</p>
          </div>
        </header>
        <div
          className="plugin-icon-modes"
          role="group"
          aria-label={t("pluginIconPicker.source")}
        >
          {(["preset", "upload", "path"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={busy || disabled}
              onClick={() => {
                if (value !== mode) setFile(undefined);
                setMode(value);
                setError(undefined);
              }}
            >
              {t(`pluginIconPicker.${value}`)}
            </button>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset key={mode} disabled={busy || disabled}>
            {mode === "preset" ? (
              <>
                <label>
                  {t("pluginIconPicker.search")}
                  <input
                    aria-label={t("pluginIconPicker.search")}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t("pluginIconPicker.searchPlaceholder")}
                  />
                </label>
                <div className="plugin-icon-grid">
                  {matches.map((item) => {
                    const Glyph = PLUGIN_PRESET_GLYPHS[item.id];
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-label={`${t(`pluginIcons.${item.id}`)} (${item.id})`}
                        aria-pressed={presetId === item.id}
                        title={item.id}
                        onClick={() => setPresetId(item.id)}
                      >
                        <Glyph size={23} />
                        <span>{t(`pluginIcons.${item.id}`)}</span>
                      </button>
                    );
                  })}
                </div>
                {!matches.length ? (
                  <p className="plugin-icon-help">
                    {t("pluginIconPicker.noMatches")}
                  </p>
                ) : null}
                <label>
                  {t("pluginIconPicker.presetId")}
                  <input
                    aria-label={t("pluginIconPicker.presetId")}
                    value={presetId}
                    onChange={(event) =>
                      setPresetId(event.target.value.trim().toLowerCase())
                    }
                    aria-invalid={!valid}
                  />
                </label>
                {!valid ? (
                  <p className="plugin-icon-help">
                    {t("pluginIconPicker.presetHelp")}
                  </p>
                ) : null}
              </>
            ) : mode === "upload" ? (
              <>
                <PluginFilePicker
                  label={t("pluginIconPicker.imageFile")}
                  inputLabel={t("pluginIconPicker.imageInput")}
                  chooseLabel={t("common.chooseFile")}
                  emptyLabel={t("common.noFileSelected")}
                  file={file}
                  accept="image/png,image/webp,.png,.webp"
                  disabled={busy || disabled}
                  onChange={(selected) => {
                    setFile(undefined);
                    setError(undefined);
                    if (!selected) return;
                    if (
                      !/\.(png|webp)$/i.test(selected.name) ||
                      selected.size > PLUGIN_ICON_MAX_BYTES ||
                      !selected.size
                    ) {
                      setError(t("pluginIconPicker.invalidFile"));
                      return;
                    }
                    setFile(selected);
                  }}
                />
                <p className="plugin-icon-help">
                  {t("pluginIconPicker.fileHelp")}
                </p>
              </>
            ) : (
              <>
                <label>
                  {t("pluginIconPicker.imagePath")}
                  <input
                    aria-label={t("pluginIconPicker.pathInput")}
                    value={assetPath}
                    onChange={(event) => setAssetPath(event.target.value)}
                    placeholder="./assets/icon.png"
                    list={pathsId}
                    aria-invalid={!valid}
                  />
                </label>
                <datalist id={pathsId}>
                  {files
                    .filter((entry) => /\.(png|webp)$/.test(entry.path))
                    .map((entry) => (
                      <option key={entry.path} value={`./${entry.path}`} />
                    ))}
                </datalist>
                <p className="plugin-icon-help">
                  {t("pluginIconPicker.pathHelp")}
                </p>
              </>
            )}
          </fieldset>
          {error ? (
            <p className="plugin-builder-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer>
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => void save({ icon: null })}
            >
              {t("pluginIconPicker.useDefault")}
            </button>
            <button type="button" disabled={busy || disabled} onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              className="plugin-install-submit"
              type="submit"
              disabled={busy || disabled || !valid}
            >
              {busy ? t("common.saving") : t("pluginIconPicker.save")}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}
