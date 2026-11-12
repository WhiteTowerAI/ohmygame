import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { ConversationCapabilities, PluginMention } from "../shared/contracts.js";
import type { PluginIcon as PluginIconValue } from "../shared/plugins.js";
import { Package } from "./icons.js";
import { readPluginIconImage } from "./api.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";

type IconPlugin = { id: string; icon?: PluginIconValue; iconRevision?: string };

const MONOGRAM_HUES = ["doc", "image", "video", "audio", "model", "code", "data"] as const;

/**
 * A plugin without an icon of its own: the first letter of its name on a
 * colour its id picks, so each looks the same everywhere and they differ from
 * one another. Fills the tile it's in.
 */
export function PluginMonogram({ id, name, size }: { id: string; name: string; size: number }): ReactNode {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  const hue = MONOGRAM_HUES[hash % MONOGRAM_HUES.length]!;
  const letter = Array.from(name.trim() || id.slice(id.indexOf("/") + 1))[0]?.toLocaleUpperCase() ?? "";
  return <span className="plugin-monogram" aria-hidden="true"
    style={{ "--monogram-hue": `var(--hue-${hue})`, fontSize: Math.round(size * 0.62) } as CSSProperties}>{letter}</span>;
}

export function PluginGlyph({
  plugin,
  size,
  setupId,
  previewAsset = false,
  name,
}: {
  plugin: IconPlugin;
  size: number;
  setupId?: string;
  previewAsset?: boolean;
  /** Without an icon, show this name's first letter instead of the package glyph. */
  name?: string;
}): ReactNode {
  const generation = useReadyRuntimeGeneration();
  const [image, setImage] = useState<string>();
  const [failed, setFailed] = useState(false);
  const asset = plugin.icon?.type === "asset" ? plugin.icon.path : undefined;
  useEffect(() => {
    setImage(undefined);
    setFailed(false);
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
          .catch(() => { if (!controller.signal.aborted) setFailed(true); });
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
        onError={() => { setImage(undefined); setFailed(true); }}
      />
    );
  // While an icon loads, a lettered tile stays empty rather than flashing its letter.
  if (name && asset && !failed) return null;
  return name ? <PluginMonogram id={plugin.id} name={name} size={size} /> : <Package size={size} aria-hidden="true" />;
}

/** A mentioned plugin's own icon, found among the installed ones. */
export function PluginMentionGlyph({ mention, plugins, size }: {
  mention: Pick<PluginMention, "name" | "marketplaceId">;
  plugins: ConversationCapabilities["plugins"];
  size: number;
}): ReactNode {
  const plugin = plugins.find((item) => item.name === mention.name && item.marketplaceId === mention.marketplaceId);
  return plugin ? <PluginGlyph plugin={plugin} size={size} /> : <Package size={size} aria-hidden="true" />;
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
      className={`plugin-row-icon${large ? " plugin-row-icon-large" : ""}`}
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
