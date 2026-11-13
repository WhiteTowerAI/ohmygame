import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { QuestionnaireSettingsStore } from "../src/daemon/questionnaire-settings.js";
import { createApp } from "../src/daemon/app.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-questions-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

it("defaults to one minute, serializes writes, and preserves saved choices", async () => {
  const root = await directory();
  const settings = new QuestionnaireSettingsStore(root);
  expect(await settings.get()).toEqual({ delaySeconds: 60 });
  await Promise.all([settings.set(60), settings.set(180), settings.set(300)]);
  expect(await new QuestionnaireSettingsStore(root).get()).toEqual({
    delaySeconds: 300,
  });
  await expect(settings.set(1)).rejects.toThrow("Invalid question timeout");
  expect(settings.seconds).toBe(300);
  await settings.set(0);
  expect(await new QuestionnaireSettingsStore(root).get()).toEqual({
    delaySeconds: 0,
  });
});

it.each([
  '{"version":2,"delaySeconds":60}',
  '{"version":1,"delaySeconds":60,"future":true}',
  "broken",
])("preserves unreadable settings: %s", async (stored) => {
  const root = await directory();
  const file = path.join(root, "questionnaire-settings.json");
  await writeFile(file, stored);
  const settings = new QuestionnaireSettingsStore(root);
  expect(await settings.get()).toMatchObject({
    delaySeconds: 0,
    problem: expect.any(String),
  });
  await expect(settings.set(60)).rejects.toThrow("cannot be read");
  expect(await readFile(file, "utf8")).toBe(stored);
});

it("validates policy changes and rejects late answers and holds at the HTTP boundary", async () => {
  const root = await directory();
  const app = createApp({
    dataDirectory: root,
    piAgentDirectory: path.join(root, "pi"),
  });
  cleanup.push(() => app.close());
  expect(
    (await app.inject({ method: "GET", url: "/settings/questions" })).json(),
  ).toEqual({ delaySeconds: 60 });
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/settings/questions",
        payload: { delaySeconds: 0 },
      })
    ).json(),
  ).toEqual({ delaySeconds: 0 });
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/settings/questions",
        payload: { delaySeconds: -1 },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/projects/missing/conversations/missing/questionnaire/gone/hold",
      })
    ).statusCode,
  ).toBe(409);
  // Twenty native options plus one custom answer must reach the project lookup.
  const values = Array.from({ length: 21 }, (_, index) =>
    `${index}`.padEnd(2000, "x"),
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/projects/missing/conversations/missing/questionnaire",
        payload: {
          requestId: "gone",
          answers: [{ questionId: "q", value: values.join(", "), values }],
        },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/projects/missing/conversations/missing/questionnaire",
        payload: {
          requestId: "gone",
          answers: [{ questionId: "q", value: "A", values: ["A", "A"] }],
        },
      })
    ).statusCode,
  ).toBe(400);
});
