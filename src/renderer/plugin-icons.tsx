import { useEffect, useState, type ReactNode } from "react";
import type { PluginSummary } from "../shared/plugins.js";
import type { PluginIconPresetId } from "../shared/plugin-icons.js";
import {
  Box,
  Brush,
  Clipboard,
  Code2,
  FileText,
  Film,
  Flag,
  Folder,
  Gamepad2,
  Globe2,
  Image,
  Layers3,
  Lightbulb,
  Music2,
  Package,
  Palette,
  Plug,
  Search,
  Server,
  Sparkles,
  Terminal,
  Video,
  WandSparkles,
  Wrench,
  type IconComponent,
} from "./icons.js";
import { GodotIcon } from "./godot-icon.js";
import { readPluginIconImage } from "./api.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";

export const PLUGIN_PRESET_GLYPHS: Record<PluginIconPresetId, IconComponent> = {
  package: Package,
  gamepad: Gamepad2,
  globe: Globe2,
  box: Box,
  image: Image,
  palette: Palette,
  brush: Brush,
  music: Music2,
  video: Video,
  film: Film,
  code: Code2,
  terminal: Terminal,
  plug: Plug,
  server: Server,
  wand: WandSparkles,
  sparkles: Sparkles,
  document: FileText,
  folder: Folder,
  layers: Layers3,
  lightbulb: Lightbulb,
  search: Search,
  wrench: Wrench,
  clipboard: Clipboard,
  flag: Flag,
};
const INCLUDED_ICONS: Record<string, IconComponent> = {
  "game-studio": Gamepad2,
  "web-game-studio": Globe2,
  "threejs-world": Box,
  img2threejs: Image,
};
type IconPlugin = Pick<
  PluginSummary,
  "id" | "name" | "source" | "icon" | "iconRevision"
>;

export function PluginGlyph({
  plugin,
  size,
  setupId,
  previewAsset = false,
}: {
  plugin: IconPlugin;
  size: number;
  setupId?: string;
  previewAsset?: boolean;
}): ReactNode {
  const generation = useReadyRuntimeGeneration();
  const [image, setImage] = useState<string>();
  const asset = plugin.icon?.type === "asset" ? plugin.icon.path : undefined;
  useEffect(() => {
    setImage(undefined);
    if (!asset) return;
    const controller = new AbortController();
    let url: string | undefined;
    const timer = window.setTimeout(
      () => {
        void readPluginIconImage(
          plugin.id,
          setupId,
          controller.signal,
          previewAsset ? asset : undefined,
        )
          .then((blob) => {
            if (controller.signal.aborted) return;
            url = URL.createObjectURL(blob);
            setImage(url);
          })
          .catch(() => {});
      },
      previewAsset ? 250 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [
    plugin.id,
    asset,
    plugin.iconRevision,
    setupId,
    generation,
    previewAsset,
  ]);
  if (asset && image)
    return (
      <img
        src={image}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        className="plugin-icon-image"
        onError={() => setImage(undefined)}
      />
    );
  if (plugin.icon?.type === "preset") {
    const Icon = PLUGIN_PRESET_GLYPHS[plugin.icon.id] ?? Package;
    return <Icon size={size} aria-hidden="true" />;
  }
  if (!plugin.icon && plugin.id === "ohmygame:godot")
    return <GodotIcon size={size} />;
  const included =
    plugin.source.type === "builtIn" || plugin.source.type === "preinstalled";
  const Icon =
    (!plugin.icon && included ? INCLUDED_ICONS[plugin.name] : undefined) ??
    Package;
  return <Icon size={size} aria-hidden="true" />;
}

export function PluginIcon({
  plugin,
  large = false,
  setupId,
  previewAsset,
}: {
  plugin: IconPlugin;
  large?: boolean;
  setupId?: string;
  previewAsset?: boolean;
}): ReactNode {
  return (
    <span
      className={`plugin-row-icon${!plugin.icon && plugin.id === "ohmygame:godot" ? " plugin-row-icon-godot" : ""}${large ? " plugin-row-icon-large" : ""}`}
    >
      <PluginGlyph
        plugin={plugin}
        size={large ? 42 : 29}
        setupId={setupId}
        previewAsset={previewAsset}
      />
    </span>
  );
}
