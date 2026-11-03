import { useEffect, useState, type ReactNode } from "react";
import type { ConversationCapabilities, PluginMention } from "../shared/contracts.js";
import type { PluginIcon as PluginIconValue } from "../shared/plugins.js";
import { Package } from "./icons.js";
import { readPluginIconImage } from "./api.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";

type IconPlugin = { id: string; icon?: PluginIconValue; iconRevision?: string };

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
  return <Package size={size} aria-hidden="true" />;
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
