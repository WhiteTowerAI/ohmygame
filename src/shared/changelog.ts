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

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const sections = new Map<string, { date: string; lines: string[] }>();
  let current: string[] | undefined;
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
    sections.set(version, { date, lines: current });
  }
  if (fence) throw new Error("Unclosed code fence in CHANGELOG.md.");
  return Array.from(sections, ([version, { date, lines }]) => {
    const notes = lines.join("\n").trim();
    const content = notes
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^#{1,6} .*$|^\[[^\]\n]+\]:.*$/gm, "")
      .trim();
    if (!content) throw new Error(`Changelog section for ${version} is empty.`);
    return { version, date, notes };
  });
}

function isDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
