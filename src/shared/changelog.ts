export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string;
}

export function isReleaseVersion(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value,
    );
  return (
    match !== null &&
    (match[4] ?? "").split(".").every((part) => !/^0\d+$/.test(part))
  );
}

const pullRequestLink =
  /\[[^\]\n]*\]\(https:\/\/github\.com\/WhiteTowerAI\/ohmygame\/pull\/(\d+)\)/g;
// A plain-text GitHub login: at most 39 characters, with single internal hyphens.
const pullRequestAuthor =
  /^\s+by @[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?![A-Za-z0-9_-])/;

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const sections = new Map<
    string,
    { date: string; lines: string[]; prose: string[] }
  >();
  let current: string[] | undefined;
  let prose: string[] | undefined;
  let fence: string | undefined;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      current?.push(line);
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker[1];
      current?.push(line);
      continue;
    }
    if (!line.startsWith("## ")) {
      current?.push(line);
      prose?.push(line);
      continue;
    }
    const heading = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/.exec(line);
    if (!heading)
      throw new Error(
        `Invalid changelog heading: ${line}. Use ## [version] - YYYY-MM-DD.`,
      );
    const [, version, date] = heading;
    if (!isReleaseVersion(version))
      throw new Error(`Invalid changelog version: ${version}.`);
    if (!date || !isDate(date))
      throw new Error(`Release ${version} needs a valid YYYY-MM-DD date.`);
    if (sections.has(version))
      throw new Error(`Duplicate changelog section for ${version}.`);
    current = [];
    prose = [];
    sections.set(version, { date, lines: current, prose });
  }
  if (fence) throw new Error("Unclosed code fence in CHANGELOG.md.");
  return Array.from(sections, ([version, { date, lines, prose }]) => {
    const notes = lines.join("\n").trim();
    const content = notes
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^#{1,6} .*$|^\[[^\]\n]+\]:.*$/gm, "")
      .trim();
    if (!content) throw new Error(`Changelog section for ${version} is empty.`);
    checkPullRequestAuthors(version, prose.join("\n"));
    return { version, date, notes };
  });
}

function checkPullRequestAuthors(version: string, text: string): void {
  // Process code spans before comments so literal <!-- inside code stays literal.
  // Code delimiters must have equal lengths; escaped backticks stay literal.
  text = text.replace(
    /\\[\s\S]|<!--[\s\S]*?-->|(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g,
    (match) => {
      if (match.startsWith("\\")) return match;
      return match.startsWith("<!--") ? "" : "\0";
    },
  );
  for (const link of text.matchAll(pullRequestLink)) {
    if (!pullRequestAuthor.test(text.slice(link.index + link[0].length)))
      throw new Error(
        `Changelog section for ${version} links PR #${link[1]} without its author. Add "by @login" after the link.`,
      );
  }
}

function isDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
