import type { StoryInteractionTimeout, StorySurfaceFiles } from "./contracts.js";

export type StoryInteractionTemplate = "blank" | "continue" | "hotspot" | "qte";

export function createStoryInteractionTemplate(template: StoryInteractionTemplate): { outcomes: string[]; timeout?: StoryInteractionTimeout; files: StorySurfaceFiles } {
  if (template === "blank") {
    return {
      outcomes: ["out"],
      files: {
        html: '<div aria-hidden="true"></div>',
        css: "html, body { width: 100%; height: 100%; margin: 0; background: transparent; }",
        javascript: `export async function run() {
  return "out";
}
`,
      },
    };
  }
  if (template === "hotspot") return { outcomes: ["success", "timeout"], timeout: { durationMs: 5_000, outcome: "timeout" }, files: hotspotFiles() };
  if (template === "qte") return { outcomes: ["success", "timeout"], timeout: { durationMs: 3_000, outcome: "timeout" }, files: qteFiles() };
  return {
    outcomes: ["continue"],
    files: {
      html: '<button id="continue" type="button">Continue</button>',
      css: `html, body { width: 100%; height: 100%; margin: 0; }
body { display: flex; box-sizing: border-box; align-items: flex-end; justify-content: center; padding-bottom: 8%; font-family: Inter, system-ui, sans-serif; }
#continue { min-width: 112px; height: 36px; padding: 0 20px; border: 1px solid rgb(255 255 255 / 72%); border-radius: 5px; background: rgb(13 15 17 / 82%); color: white; font: inherit; cursor: pointer; }`,
      javascript: `export async function run({ ui }) {
  await ui.waitForClick("#continue");
  return "continue";
}
`,
    },
  };
}

function hotspotFiles(): StorySurfaceFiles {
  return {
    html: '<button id="hotspot" type="button">Click area</button>',
    css: `html, body { width: 100%; height: 100%; margin: 0; }
body { position: relative; font-family: Inter, system-ui, sans-serif; }
#hotspot { position: absolute; left: 35%; top: 35%; width: 30%; height: 30%; border: 1px solid rgb(255 255 255 / 78%); border-radius: 4px; background: rgb(17 18 20 / 42%); color: white; font: inherit; cursor: pointer; }`,
    javascript: `export async function run({ ui }) {
  await ui.waitForClick("#hotspot");
  return "success";
}
`,
  };
}

function qteFiles(): StorySurfaceFiles {
  return {
    html: '<div id="qte"><span>Act now</span><button id="action" type="button">E</button></div>',
    css: `html, body { width: 100%; height: 100%; margin: 0; }
body { display: grid; place-items: center; font-family: Inter, system-ui, sans-serif; }
#qte { display: grid; justify-items: center; gap: 14px; color: white; font-weight: 700; text-shadow: 0 2px 10px #000; }
#action { min-width: 62px; min-height: 54px; border: 2px solid #fff; border-radius: 6px; background: rgb(9 10 12 / 84%); color: white; font: 700 16px Inter, system-ui, sans-serif; cursor: pointer; }`,
    javascript: `export async function run({ ui }) {
  await Promise.race([
    ui.waitForClick("#action").then(() => "success"),
    ui.waitForKey("KeyE").then(() => "success"),
  ]);
  return "success";
}
`,
  };
}
