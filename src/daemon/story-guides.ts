import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// compat: since beta.5.12, remove from beta.7 and 2026-12-27. Stories became web games and the Story editor is
// gone, but a web story's AGENTS.md and README.md, which OhMyGame wrote, still describe the editor and its tools.

/** SHA-256 of each AGENTS.md and README.md OhMyGame wrote into a story. */
const WRITTEN: Record<"AGENTS.md" | "README.md", ReadonlySet<string>> = {
  "AGENTS.md": new Set([
    "2466f982c14b84abb66f1521664644b687eb21c10f27f72bc6eedd807d9171d1",
    "78bab6b86ae039e0b63d14da74e6f5f3fb3eca4ffbd2399de845a643d7ed699e",
    "bad327183e1b955b2b1f24a5fc0dbd9b691f0b5fc006773fef2a86e8ced475d5",
    "8619c00f6a6ec09d6dfdaf99a2f84bc79fbd1214da156776701306fe9ba585ed",
    "6756f06173ada0f8dbd0f805df7be19c754468ce33b9834d1f1caa130c09181c",
    "1f2de44de2cc69a1d740b1152bad62060f3d8c8b511016dbb64f42e36c73e436",
    "94f6d304d6d40626a6a18661113ebe4bdc2674117ec19b0e4b28c26e9fbbb35b",
    "fa451c238c2e49ff840c6811abb3fda53cdf385e97cd5d9916e6f78dff9855b8",
    "d30f197e794b25e294bb8c6214fe44a3af9dab35d27549be689c8596a6b434fa",
    "d5fb3ee3e78620e2eee3e4d9c34696f944aa0ca321f6352d307bfedc2951bd9c",
    "b35b898bce87d299f531d1f2a53f9848dfacbe749b2ded64905258e4838a51fe",
  ]),
  "README.md": new Set([
    "311594a64abc80d5b1c8270e064375268f8bb3eff44e58f634c3d275208c65e2",
    "781d2b099d3acc5d87555668f8d935acbbbbccbddb39e052471367224275dc6f",
    "547ed93bccfae4980075bfb76e8586971acb71de10ce4896def59d0a0ead4a6c",
    "0e99e5862388f7a8e3e3139f7d948f801b0fd843a8568a95e5635cffa4c0bbd4",
    "a9054d6e699cf6741d3056a2a121049363e17bf4ad9fa47df6954e8246086774",
    "cb267e6e75e349a899668e9b03ce37a9936e68f401f6bd8764223c3634d64b13",
    "6ebb841a7c5c875dc4664bba88e13afff779bfb12c4360a7c73c73a912d70abf",
    "4052058962f0c463ae27c1f683b7ff8fd8c3e91e0c181cf4d79b654be198abb2",
    "08f53ce0f8162031200e264f0d0d96aa6f8e0c679808620d95116b01de104b3a",
    "0e821e2b173e3c85bb527199c62b7a7ca9c83111d3cade5af5605d9ff3e9c88f",
  ]),
};

/** The guides a story gets now, as the Interactive Story plugin's template has them. */
export const STORY_GUIDES: Record<"AGENTS.md" | "README.md", string> = {
  "AGENTS.md": "# Interactive Story\n\nThis project is an interactive story played as a web page: Scenes joined by\nthe player's choices, such as a visual novel or an interactive film. When the\nInteractive Story Skill is available, read it first: it adds Scenes from\nstarters and checks the story.\n\n- `index.html` loads the story runtime in `story/`, which reads `graph.json`\n  and plays each Scene from its own files. Open the page to play.\n- `graph.json` is the story's flow: the viewport, the starting State and its\n  Variables, the Assets, the Scenes (`nodes`) with their Exits (`signals`), and\n  the connections (`edges`). `schemas/graph.schema.json` is its exact shape.\n- A Scene's HTML, CSS and JavaScript are ordinary files under `nodes/<id>/`,\n  named by its `source`. Its JavaScript exports `mount(context)`, renders into\n  `context.root`, and may return a cleanup function. `README.md` lists\n  everything `context` offers.\n- A Scene leaves only through an Exit it declares:\n  `context.navigation.emit(exitId)`. Exits describe outcomes, not targets; a\n  connection in `graph.json` decides where each one goes. Use `replace` for\n  going forward and `push` only when the player should be able to return with\n  `context.navigation.back()`.\n- Read and change the game's State through `context.state`. A top-level State\n  key is a Variable: something that crosses Scenes or belongs in the save,\n  such as `trust` or an `inventory` list. Give each a starting value in\n  `initialState` and one line in `variables`. Progress inside one Scene stays\n  in its code.\n- To branch on progress, read State in the Scene and emit a different Exit for\n  each outcome. Give such an Exit a `when`, one short sentence saying when it\n  is taken, such as \"if trust is 3 or more\", and keep it true when the logic\n  changes.\n- Every Scene must show something sensible with the starting State.\n- A Scene may use only Assets listed in its `assets`, resolved with\n  `context.assets.url(assetId)`. Media goes in `graph.json` `assets` as a\n  project file, so publishing includes it.\n- Build every screen with the Project Style in `shared/style/`: import\n  `shared/style/components.css` from a Scene's CSS and use its tokens and\n  classes. Add a token or component there instead of hard-coding values, and\n  restyle the game there first.\n- A Scene's background is one\n  `<div class=\"backdrop\" data-media=\"backdrop\" data-asset=\"ID\" data-type=\"video|image\">`\n  inside a `.has-backdrop` container. To change it, change those two\n  attributes. `showBackdrop(context)` and `playScene(context, { signal })`\n  from `shared/style/components.js` show it. To trim a background video, set\n  `data-clip-start` and/or `data-clip-end` (seconds in the original file) on\n  that element.\n- Music that carries on across Scenes goes through\n  `context.audio.music(assetId)`, not an `<audio>` element. A Scene that reads\n  a long sequence one step at a time keeps its place with `context.position`,\n  so Continue returns there.\n- UI shown on more than one Scene, such as a Home button, is a shared\n  component under `shared/components/` that each Scene imports; it emits that\n  Scene's Exits, so each one declares them. Mark an Exit that is a way around\n  the game rather than a step in the story, such as Home or Settings, with\n  `\"role\": \"navigation\"`. An entry whose Exit may go nowhere checks\n  `context.navigation.connected(exitId)` and shows disabled.\n- Scene code loads as browser modules, with no bundler: import project files\n  by relative path, fetch text with\n  `await (await fetch(new URL(\"./script.txt\", import.meta.url))).text()`, and\n  import JSON with `with { type: \"json\" }`. Packages from `node_modules` are\n  not available.\n- The runtime in `story/` is this project's code. Change it when the game\n  needs something it doesn't do, and keep `graph.json` as the flow, the\n  `context` each Scene receives, and the `scene` query parameter, which starts\n  the page at a Scene.\n- Keep IDs and file paths stable when changing a Scene. Before publishing,\n  every Exit other than navigation ones must be connected.\n\nThe author thinks in Scenes, Exits and Variables, not keys and code: say \"the\n`trust` Variable\" and \"the Exit is taken if trust is 3 or more\".\n",
  "README.md": "# Interactive Story\n\nThis project is made of one graph plus ordinary browser source files. Every Node has the same capabilities; names such as menu, scene, archive, or puzzle are authoring ideas rather than runtime types.\n\n## Files\n\n- `index.html` is the page that plays the story; `story/` is the runtime it loads.\n- `graph.json` is the runtime graph and dependency manifest.\n- `nodes/<id>/` contains a Node's HTML, CSS, and JavaScript.\n- `shared/` contains ordinary modules imported by more than one Node.\n- `shared/components/` contains UI shown on more than one Node, such as a Home button.\n- `shared/style/` is the Project Style: `theme.css` tokens, `components.css` classes, and `components.js` components such as `playScene()`.\n- `schemas/` contains the exact persisted JSON contracts.\n- `.ohmygame/` is OhMyGame's own data, such as asset records. It is never published; leave it alone.\n\n## Node API\n\nBackground videos support optional `data-clip-start` / `data-clip-end`\nattributes on their `data-media=\"backdrop\"` element. Values are non-negative\nseconds in the original video, end greater than start; omitted values mean\nzero and the natural end. Trimming is per Scene, does not modify the original\nAsset, and does not reduce its published size. The shared runtime plays this range\nand emits `ended` at its end. Remove the attributes to restore the full video.\n\nEach Node module exports `mount(context)`. The Runtime supplies:\n\n- `context.root`: the Node's isolated ShadowRoot.\n- `context.assets.url(id)`: a URL for an Asset declared by this Node.\n- `context.state.get(key)`, `set(key, value)`, `patch(values)`, and `subscribe(listener)`.\n- `context.navigation.emit(signalId)`, `back()`, and `connected(signalId)`, which is true when this Node declares the Signal and an edge routes it.\n- `context.session.hasSave()`, `save()`, `continue()`, `restart()`, and `reset()`; save slots with `slots()`, `saveSlot(id, note)`, `loadSlot(id)`, and `deleteSlot(id)`.\n- `context.position.get()` and `set(value)`: where the player is inside this Node, as JSON the Node chooses. It is kept with the save and on the back stack; a Node entered by a Signal starts with `null`.\n- `context.audio.music(assetId | null, { fade })` and `sound(assetId)`: music plays on across Nodes until a Node changes it, and turns down while a Node's video or audio plays with sound.\n- `context.preferences.get()` and `set(values)`: the player's settings, kept across games. `musicVolume` and `soundVolume` (0 to 1) set the volumes; other keys are the project's.\n- `context.story.seen()`: what the player has seen across every game, as `{ nodes, edges }` mapping each Node ID first entered and edge ID first taken to when. A preview gives every Node and edge.\n- `context.story.seenBefore`: true when the player entered this Node before, earlier in this game or in another one, so a Scene can offer to skip it. Always false in a preview.\n- `context.lifecycle.signal`: aborted before cleanup when the Node exits.\n\nA shared component receives the Node's context from the Node that mounts it, so it emits that Node's Signals: every Node that shows it declares them in `graph.json`.\n\nThe mount function may return a synchronous or asynchronous cleanup function.\n\nThe page loads each Scene's files as they are: modules import local files by relative path, text files are fetched, and JSON imports use `with { type: \"json\" }`. The runtime under `story/` is the project's own and can be changed. OhMyGame publishes this as a static web game. Review the publishing contents and keep drafts and unused media outside the published folder.\n",
};

const EDITOR_GUIDE = "# Playable Nodes Project";
export const STORY_GUIDE_NOTE = "## OhMyGame no longer has a Story editor";
const NOTE = `\n\n${STORY_GUIDE_NOTE}\n\nThis story is a web game. OhMyGame no longer has the Story editor, the \`playable_add_node\` and \`playable_check\` tools, or runtime updates for \`story/\`. Where this file mentions them, change \`graph.json\` and the Scenes' files directly, and treat \`story/\` as this project's own code. Review the static web game's publishing contents for drafts and unused media.\n`;

/**
 * Brings a web story's guides up to date: one OhMyGame wrote and no one
 * changed is replaced; an AGENTS.md OhMyGame wrote that was changed since
 * keeps its text and gains a note that the editor is gone. A folder that isn't
 * a web story, with `graph.json`, `index.html` and `story/`, is left alone.
 */
export async function refreshStoryGuides(folder: string): Promise<void> {
  if (!(await isWebStory(folder))) return;
  for (const name of ["AGENTS.md", "README.md"] as const) {
    const file = path.join(folder, name);
    const current = await readFile(file, "utf8").catch(() => undefined);
    if (current === undefined) continue;
    // Git may have checked the file out with Windows line endings; OhMyGame wrote it with Unix ones.
    if (WRITTEN[name].has(createHash("sha256").update(current.replaceAll("\r\n", "\n")).digest("hex"))) await replace(file, STORY_GUIDES[name]);
    else if (name === "AGENTS.md" && current.startsWith(EDITOR_GUIDE) && !current.includes(STORY_GUIDE_NOTE)) await replace(file, `${current.trimEnd()}${NOTE}`);
  }
}

async function isWebStory(folder: string): Promise<boolean> {
  const kinds = await Promise.all(["graph.json", "index.html", "story"].map((name) => stat(path.join(folder, name)).catch(() => undefined)));
  return Boolean(kinds[0]?.isFile() && kinds[1]?.isFile() && kinds[2]?.isDirectory());
}

async function replace(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
