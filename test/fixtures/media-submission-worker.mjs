import { mediaTaskJournal } from "../../src/daemon/media-task-journal.ts";

const [directory, boundary] = process.argv.slice(2);
const journal = await mediaTaskJournal(directory, "interrupted");
await journal.begin({ provider: "fixture", request: "chair" });
const checkpoint = async () => {
  process.send({ checkpoint: boundary });
  await new Promise(() => setInterval(() => {}, 1000));
};
await journal.submit(
  "preview",
  "fixture-adapter",
  { prompt: "chair" },
  async () => {
    if (boundary === "submitted") await checkpoint();
    return { id: "paid-preview" };
  },
);
await checkpoint();
