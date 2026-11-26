import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refreshStoryGuides, STORY_GUIDE_NOTE, STORY_GUIDES } from "../src/daemon/story-guides.js";

// The AGENTS.md and README.md OhMyGame wrote into a web story before the Story editor was removed.
const written = {
  agents: await readFile("test/fixtures/story-guides/AGENTS.md", "utf8"),
  readme: await readFile("test/fixtures/story-guides/README.md", "utf8"),
};

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function story(files: Record<string, string>, web = true): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-story-guides-"));
  folders.push(folder);
  if (web) {
    await mkdir(path.join(folder, "story"));
    await writeFile(path.join(folder, "index.html"), "<p>");
  }
  await writeFile(path.join(folder, "graph.json"), "{}");
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(folder, name), content);
  return folder;
}
const read = (folder: string, name: string) => readFile(path.join(folder, name), "utf8");

describe("Story guides", () => {
  it("replaces the guides OhMyGame wrote that no one changed", async () => {
    const folder = await story({ "AGENTS.md": written.agents, "README.md": written.readme });
    await refreshStoryGuides(folder);
    expect(await read(folder, "AGENTS.md")).toBe(STORY_GUIDES["AGENTS.md"]);
    expect(await read(folder, "README.md")).toBe(STORY_GUIDES["README.md"]);
    expect(STORY_GUIDES["AGENTS.md"]).not.toContain("playable_add_node");
  });

  it("knows a guide OhMyGame wrote checked out with Windows line endings", async () => {
    const folder = await story({ "AGENTS.md": written.agents.replaceAll("\n", "\r\n") });
    await refreshStoryGuides(folder);
    expect(await read(folder, "AGENTS.md")).toBe(STORY_GUIDES["AGENTS.md"]);
  });

  it("notes the editor is gone in a changed AGENTS.md, once, and leaves other files as they are", async () => {
    const agents = `${written.agents}\n- Keep the narrator in second person.\n`;
    const folder = await story({ "AGENTS.md": agents, "README.md": "# Night Train\n" });
    await refreshStoryGuides(folder);
    await refreshStoryGuides(folder);
    const result = await read(folder, "AGENTS.md");
    expect(result.startsWith(agents.trimEnd())).toBe(true);
    expect(result.split(STORY_GUIDE_NOTE)).toHaveLength(2);
    expect(await read(folder, "README.md")).toBe("# Night Train\n");
  });

  it("leaves a guide the author wrote, and a folder that isn't a web story", async () => {
    const own = await story({ "AGENTS.md": "# Night Train\n" });
    await refreshStoryGuides(own);
    expect(await read(own, "AGENTS.md")).toBe("# Night Train\n");
    const old = await story({ "AGENTS.md": written.agents }, false);
    await refreshStoryGuides(old);
    expect(await read(old, "AGENTS.md")).toBe(written.agents);
  });
});
