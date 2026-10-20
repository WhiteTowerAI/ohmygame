import { rm } from "node:fs/promises";
import path from "node:path";

await Promise.all(
  ["desktop", "daemon", "shared", "renderer", "story-web"]
    .map((directory) => rm(path.resolve("dist", directory), { recursive: true, force: true })),
);
