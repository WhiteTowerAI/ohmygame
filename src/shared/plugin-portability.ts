import type {
  PluginDetail,
  PluginSettings,
  PluginMarketplaceRef,
} from "./plugins.js";

export interface PluginArchivePreview {
  plugin: PluginDetail;
  marketplace: PluginMarketplaceRef;
  existingRevision?: string;
  restoresSettings: boolean;
}

export interface PluginDependencyCheck {
  code:
    | "command"
    | "platform"
    | "path"
    | "cwd"
    | "configuration"
    | "unpinned-package"
    | "absolute-path";
  target: string;
  status: "ok" | "warning" | "error";
}
export interface PluginDiagnostics {
  checks: PluginDependencyCheck[];
}

export interface PluginPortableSettings {
  version: 1;
  marketplace: PluginMarketplaceRef;
  settings: PluginSettings;
  values: Record<string, string | boolean>;
}
