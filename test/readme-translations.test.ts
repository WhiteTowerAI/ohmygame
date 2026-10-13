import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The QQ group is a community entry for Chinese readers only.
const QQ_GROUP = /<a href="https:\/\/qun\.qq\.com\/[^"]*">[\s\S]*?<\/a>/g;
const LANGUAGE_LINKS = new Set(["README.md", "README.zh-CN.md"]);

async function readme(name: string): Promise<string> {
  return readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

function sharedContent(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "").replace(QQ_GROUP, "");
}

function headingLevels(markdown: string): string[] {
  return (
    sharedContent(markdown)
      .replace(/```[\s\S]*?```/g, "")
      .match(/^#{2,6} /gm) ?? []
  );
}

function links(markdown: string): string[] {
  const text = sharedContent(markdown);
  const targets = [
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!),
    ...[...text.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]!),
    ...(text.match(/^https:\/\/github\.com\/user-attachments\/\S+$/gm) ?? []),
  ];
  return targets.filter(
    (target) => !target.startsWith("#") && !LANGUAGE_LINKS.has(target),
  );
}

/** GitHub's heading anchors: lowercase, punctuation removed, spaces become hyphens. */
function anchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

function brokenAnchors(markdown: string): string[] {
  const anchors = new Set(
    (sharedContent(markdown).match(/^#{1,6} .+$/gm) ?? []).map((line) =>
      anchor(line.replace(/^#+ /, "")),
    ),
  );
  return [...markdown.matchAll(/(?:href="|\]\()#([^")]+)/g)]
    .map((match) => match[1]!)
    .filter((target) => !anchors.has(target));
}

describe("README translations", () => {
  it("keeps the Chinese README aligned with the English source", async () => {
    const [english, chinese] = await Promise.all([
      readme("README.md"),
      readme("README.zh-CN.md"),
    ]);
    expect(headingLevels(chinese)).toEqual(headingLevels(english));
    expect(links(chinese)).toEqual(links(english));
  });

  it("links each README to the other language", async () => {
    const [english, chinese] = await Promise.all([
      readme("README.md"),
      readme("README.zh-CN.md"),
    ]);
    expect(english).toContain('<a href="README.zh-CN.md">简体中文</a>');
    expect(chinese).toContain('<a href="README.md">English</a>');
  });

  it("points in-page links at existing headings", async () => {
    const [english, chinese] = await Promise.all([
      readme("README.md"),
      readme("README.zh-CN.md"),
    ]);
    expect(brokenAnchors(english)).toEqual([]);
    expect(brokenAnchors(chinese)).toEqual([]);
  });
});
