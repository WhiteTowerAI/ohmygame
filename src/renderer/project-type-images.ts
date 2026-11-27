/**
 * The pictures on the app's project type cards and the new project dialog's
 * banner: one soft-lit diorama per type, made as one set so they sit together.
 * The subject keeps to the right, since the card dissolves the picture in from
 * its left under the type's name. A plugin's type brings its own `cover`, or
 * gets PLUGIN_TYPE_IMAGE.
 */
import webGame from "./assets/project-types/web-game.webp";
import godotGame from "./assets/project-types/godot-game.webp";
import general from "./assets/project-types/general.webp";
import assetCanvas from "./assets/project-types/asset-canvas.webp";
import plugin from "./assets/project-types/plugin.webp";

export const TYPE_IMAGES: Readonly<Record<string, string>> = {
  "web-game": webGame,
  "godot-game": godotGame,
  general,
  "asset-canvas": assetCanvas,
};

export const PLUGIN_TYPE_IMAGE = plugin;
