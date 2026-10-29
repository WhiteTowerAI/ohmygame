import path from "node:path";
import { realpathSync } from "node:fs";

/** Resolve links even when the final file has not been created yet. */
export function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  let current = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function inside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
