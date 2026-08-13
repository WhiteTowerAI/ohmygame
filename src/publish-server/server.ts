import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublishApp } from "./app.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env.local"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const token = process.env.PUBLISH_TOKEN;
if (!token) throw new Error("PUBLISH_TOKEN is required");

const host = process.env.PUBLISH_HOST ?? "127.0.0.1";
const port = Number(process.env.PUBLISH_PORT ?? 43130);
const app = createPublishApp({
  dataDirectory: process.env.PUBLISH_DATA_DIR ?? path.join(repositoryRoot, ".data", "publish"),
  playOrigin: process.env.PUBLISH_PLAY_ORIGIN ?? `http://localhost:${port}`,
  publisher: { id: process.env.PUBLISHER_ID ?? "local-publisher", token },
  logger: true,
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
