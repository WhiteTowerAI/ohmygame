import type { ConversationCapabilities } from "../shared/contracts.js";
import { t } from "./i18n.js";
import type en from "./locales/en.js";
import {
  Book,
  Box,
  Camera,
  CircleHelp,
  ClipboardList,
  Cpu,
  Film,
  GalleryWide,
  Gamepad2,
  Globe2,
  Image,
  Import,
  LayoutGrid,
  Maximize,
  Music2,
  Plug,
  Running,
  Scissors,
  Search,
  UsersGroupRounded,
  WandSparkles,
  type IconComponent,
} from "./icons.js";
import { humanizeIdentifier } from "./mcp-tool-presentation.js";

type ToolTexts = keyof typeof en.timeline.tools;

/** OhMyGame's own tools, each with its icon and the texts under `timeline.tools.<key>`. */
const BUILT_IN_TOOLS: Record<string, { icon: IconComponent; key: ToolTexts }> = {
  generate_image: { icon: WandSparkles, key: "generateImage" },
  remove_image_background: { icon: Scissors, key: "removeBackground" },
  crop_image: { icon: Maximize, key: "cropImage" },
  image_grid_split: { icon: LayoutGrid, key: "splitGrid" },
  recall_image: { icon: Image, key: "recallImage" },
  generate_video: { icon: Film, key: "generateVideo" },
  video_frame_strip: { icon: Film, key: "videoFrames" },
  video_compose_frames: { icon: Film, key: "composeVideo" },
  extract_gif_frames: { icon: GalleryWide, key: "gifFrames" },
  compose_gif: { icon: GalleryWide, key: "composeGif" },
  generate_3d_asset: { icon: Box, key: "generate3d" },
  animate_3d_asset: { icon: Running, key: "animate3d" },
  generate_audio: { icon: Music2, key: "generateAudio" },
  inspect_media_models: { icon: Cpu, key: "mediaModels" },
  list_background_removal_models: { icon: Cpu, key: "mediaModels" },
  canvas_check: { icon: LayoutGrid, key: "canvasCheck" },
  canvas_initialize: { icon: LayoutGrid, key: "canvasInit" },
  generate_canvas_media: { icon: WandSparkles, key: "canvasMedia" },
  project_guide: { icon: Book, key: "projectGuide" },
  panel_screenshot: { icon: Camera, key: "panelScreenshot" },
  browser_use: { icon: Globe2, key: "browser" },
  web_fetch: { icon: Globe2, key: "webFetch" },
  questionnaire: { icon: CircleHelp, key: "questionnaire" },
  update_plan: { icon: ClipboardList, key: "updatePlan" },
  install_plugin: { icon: Plug, key: "installPlugin" },
  fork_plugin: { icon: Plug, key: "forkPlugin" },
  plugin_manage: { icon: Plug, key: "managePlugins" },
  game_sdk_setup: { icon: Gamepad2, key: "gameSdk" },
  multiplayer_setup: { icon: UsersGroupRounded, key: "multiplayerSetup" },
  multiplayer_rules_test: { icon: UsersGroupRounded, key: "multiplayerTest" },
  // The Library's tools, by the names older conversations keep.
  library_search: { icon: Search, key: "assetSearch" },
  library_use: { icon: Import, key: "assetUse" },
};

type Plugins = ConversationCapabilities["plugins"];
export type PluginToolPlugin = Plugins[number] | { id: string; displayName: string };

/** One of OhMyGame's own tools: its icon and texts. */
export function builtInTool(name: string): { icon: IconComponent; name: string; running: string; done: (count?: number) => string } | undefined {
  const tool = BUILT_IN_TOOLS[name];
  if (!tool) return undefined;
  return {
    icon: tool.icon,
    name: t(`timeline.tools.${tool.key}.name`),
    running: t(`timeline.tools.${tool.key}.running`),
    done: (count = 1) => t(`timeline.tools.${tool.key}.done`, { count }),
  };
}

/**
 * A plugin's tool, which agents see as `publisher__name__tool`: the plugin,
 * as the conversation lists it or from its id when it is gone, and the tool's
 * name in words.
 */
export function pluginTool(name: string, plugins: Plugins): { plugin: PluginToolPlugin; tool: string } | undefined {
  const parts = name.split("__");
  if (parts.length !== 3 || parts.some((part) => !part)) return undefined;
  const id = `${parts[0]}/${parts[1]}`;
  const plugin = plugins.find((candidate) => candidate.id === id) ?? { id, displayName: humanizeIdentifier(parts[1]!) };
  return { plugin, tool: humanizeIdentifier(parts[2]!) };
}

/** What to call a tool in a short line, as "Queued: …". */
export function toolDisplayName(name: string, plugins: Plugins): string {
  const builtIn = builtInTool(name);
  if (builtIn) return builtIn.name;
  const plugin = pluginTool(name, plugins);
  if (plugin) return t("timeline.pluginTool", { plugin: plugin.plugin.displayName, tool: plugin.tool });
  return humanizeIdentifier(name);
}

/** The icon a tool shows when no plugin's icon stands for it. */
export function builtInToolIcon(name: string): IconComponent | undefined {
  return BUILT_IN_TOOLS[name]?.icon ?? (pluginTool(name, []) ? Plug : undefined);
}
