import type { StoryInteractionBehavior, StorySurfaceFiles } from "./contracts.js";

export function createStoryInteractionFiles(behavior: StoryInteractionBehavior): StorySurfaceFiles {
  if (behavior.type === "actions") return {
    html: '<div aria-hidden="true"></div>',
    css: "html, body { width: 100%; height: 100%; margin: 0; background: transparent; }",
    javascript: `export async function run() {
  return "out";
}
`,
  };
  if (behavior.type === "hotspot") return hotspotFiles(behavior);
  if (behavior.type === "qte") return qteFiles(behavior);
  return {
    html: `<button id="continue" type="button">${escapeHtml(behavior.label || "Continue")}</button>`,
    css: `html, body { width: 100%; height: 100%; margin: 0; }
body { display: flex; box-sizing: border-box; align-items: flex-end; justify-content: center; padding-bottom: 8%; font-family: Inter, system-ui, sans-serif; }
#continue { min-width: 112px; height: 36px; padding: 0 20px; border: 1px solid rgb(255 255 255 / 72%); border-radius: 5px; background: rgb(13 15 17 / 82%); color: white; font: inherit; cursor: pointer; }`,
    javascript: `export async function run({ ui }) {
  await ui.waitForClick("#continue");
  return "continue";
}
`,
  };
}

function hotspotFiles(behavior: Extract<StoryInteractionBehavior, { type: "hotspot" }>): StorySurfaceFiles {
  return {
    html: `<button id="hotspot" type="button">${escapeHtml(behavior.label || "Hotspot")}</button>`,
    css: `html, body { width: 100%; height: 100%; margin: 0; }
body { position: relative; font-family: Inter, system-ui, sans-serif; }
#hotspot { position: absolute; left: ${behavior.region.x * 100}%; top: ${behavior.region.y * 100}%; width: ${behavior.region.width * 100}%; height: ${behavior.region.height * 100}%; border: 1px solid rgb(255 255 255 / 78%); border-radius: 4px; background: rgb(17 18 20 / 42%); color: white; font: inherit; cursor: pointer; }`,
    javascript: `export async function run({ ui }) {
  await ui.waitForClick("#hotspot");
  return "success";
}
`,
  };
}

function qteFiles(behavior: Extract<StoryInteractionBehavior, { type: "qte" }>): StorySurfaceFiles {
  return {
    html: `<div id="qte"><span>${escapeHtml(behavior.prompt || "Act now")}</span><button id="action" type="button">${escapeHtml(qteKeyLabel(behavior.key))}</button></div>`,
    css: `html, body { width: 100%; height: 100%; margin: 0; }
body { display: grid; place-items: center; font-family: Inter, system-ui, sans-serif; }
#qte { display: grid; justify-items: center; gap: 14px; color: white; font-weight: 700; text-shadow: 0 2px 10px #000; }
#action { min-width: 62px; min-height: 54px; border: 2px solid #fff; border-radius: 6px; background: rgb(9 10 12 / 84%); color: white; font: 700 16px Inter, system-ui, sans-serif; cursor: pointer; }`,
    javascript: `export async function run({ ui }) {
  await Promise.race([ui.waitForClick("#action"), ui.waitForKey(${JSON.stringify(behavior.key)})]);
  return "success";
}
`,
  };
}

function qteKeyLabel(code: string): string {
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code.replace("Arrow", "");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
