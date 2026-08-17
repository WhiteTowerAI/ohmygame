import { rm } from "node:fs/promises";
import path from "node:path";

await Promise.all(
  ["desktop", "daemon", "shared", "renderer"]
    .map((directory) => rm(path.resolve("dist", directory), { recursive: true, force: true })),
);
