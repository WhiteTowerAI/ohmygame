import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureOhMyGamePiEnvironment,
  withoutOhMyGameManagedPiPackages,
} from "../src/daemon/pi-agent.js";
import { pluginCreatorSkill } from "../src/daemon/plugin-authoring.js";
import { inspectPluginDraft } from "../src/daemon/plugin-draft.js";
import { PLUGIN_TEMPLATE_PARTS, pluginPackageFiles } from "../src/shared/plugin-template.js";

describe("OhMyGame Pi environment", () => {
  it("removes only the legacy app-managed MCP adapter package", () => {
    const configured = [
      "npm:pi-web-access",
      { source: "npm:pi-mcp-adapter@2.27.0", extensions: ["extensions/index.ts"] },
      "github:example/custom-extension",
    ];
    expect(withoutOhMyGameManagedPiPackages(configured)).toEqual([
      "npm:pi-web-access",
      "github:example/custom-extension",
    ]);
    const userPackages = ["npm:pi-web-access"];
    expect(withoutOhMyGameManagedPiPackages(userPackages)).toBe(userPackages);
  });

  it("creates the plugin creator skill without writing ambient MCP configuration", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "ohmygame-pi-agent-"));
    const skill = path.join(agentDir, "skills/plugin-creator");
    await mkdir(path.join(skill, "references"), { recursive: true });
    await writeFile(path.join(skill, "references/retired.md"), "An older app's reference");
    await ensureOhMyGamePiEnvironment(agentDir);
    expect(await readFile(path.join(skill, "SKILL.md"), "utf8")).toMatch(/^---\nname: plugin-creator\ndescription: /);
    await expect(readFile(path.join(skill, "references/retired.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(agentDir, "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("links the plugin creator skill only to files it has", async () => {
    const files = await pluginCreatorSkill(path.resolve("packages/plugin-ui"));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["references/page-api.d.ts", "references/page-components.d.ts"]));
    for (const [file, contents] of Object.entries(files)) {
      for (const [, target] of contents.matchAll(/\]\(([^)#\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target)) continue;
        expect(files, `${file} links ${target}`).toHaveProperty([path.posix.join(path.posix.dirname(file), target)]);
      }
    }
  });

  it.each(PLUGIN_TEMPLATE_PARTS)("shows a %s example the Plugin Builder can install", async (part) => {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-example-"));
    const files = pluginPackageFiles({ publisher: "personal", name: "example", displayName: "Example", description: "An example plugin.", parts: [part] });
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), contents);
    }
    const draft = await inspectPluginDraft(root);
    expect(draft.errors).toEqual([]);
    expect(draft.plugin?.id).toBe("personal/example");
  });
});
