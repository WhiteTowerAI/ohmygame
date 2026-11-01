export const PLUGIN_ICON_MEDIA_TYPES = {
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
} as const;
export type PluginIconMediaType = (typeof PLUGIN_ICON_MEDIA_TYPES)[keyof typeof PLUGIN_ICON_MEDIA_TYPES];

export const PLUGIN_ICON_MAX_BYTES = 1024 * 1024;
export const PLUGIN_ICON_MAX_DIMENSION = 2048;
