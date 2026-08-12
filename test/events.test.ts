import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeEventBus } from "../src/shared/events.js";

describe("RuntimeEventBus", () => {
  it("replays after a cursor and streams new events", () => {
    const bus = new RuntimeEventBus();
    const first = bus.publish("a", "project.created", { name: "A" });
    bus.publish("b", "project.created", { name: "B" });
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("a", listener);
    const second = bus.publish("a", "preview.starting", {});
    expect(bus.since("a", first.id)).toEqual([second]);
    expect(listener).toHaveBeenCalledWith(second);
    unsubscribe();
  });

  it("retains only its configured replay capacity", () => {
    const bus = new RuntimeEventBus(2);
    bus.publish("a", "preview.starting", {});
    const second = bus.publish("a", "preview.stopped", {});
    const third = bus.publish("a", "preview.starting", {});
    expect(bus.since("a")).toEqual([second, third]);
  });

  it("replays pending in-memory events before their file exists", async () => {
    const projectsDirectory = await mkdtemp(path.join(tmpdir(), "open-game-events-"));
    await mkdir(path.join(projectsDirectory, "a"), { recursive: true });
    await mkdir(path.join(projectsDirectory, "other"), { recursive: true });
    const bus = new RuntimeEventBus(2, projectsDirectory);
    bus.publish("other", "preview.starting", {});
    const event = bus.publish("a", "preview.starting", {});

    expect(bus.since("a", 0)).toEqual([event]);
    await bus.flush();
  });

  it("restores persisted events and continues the global cursor", async () => {
    const projectsDirectory = await mkdtemp(path.join(tmpdir(), "open-game-events-"));
    await mkdir(path.join(projectsDirectory, "a"), { recursive: true });
    const firstBus = new RuntimeEventBus(1_000, projectsDirectory);
    firstBus.publish("a", "project.created", { name: "A" });
    const last = firstBus.publish("a", "agent.started", { prompt: "Build" });
    await firstBus.flush();

    const restoredBus = new RuntimeEventBus(1_000, projectsDirectory);
    await restoredBus.load(["a"]);
    expect(restoredBus.since("a")).toHaveLength(2);
    expect(restoredBus.publish("a", "agent.cancelled", {}).id).toBe(last.id + 1);
    await restoredBus.flush();
    expect((await readFile(path.join(projectsDirectory, "a", "events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(3);
  });

  it("replays older persisted events beyond the in-memory window", async () => {
    const projectsDirectory = await mkdtemp(path.join(tmpdir(), "open-game-events-"));
    await mkdir(path.join(projectsDirectory, "a"), { recursive: true });
    const bus = new RuntimeEventBus(2, projectsDirectory);
    const first = bus.publish("a", "preview.starting", {});
    bus.publish("a", "preview.stopped", {});
    bus.publish("a", "preview.starting", {});
    await bus.flush();

    expect(bus.since("a")).toHaveLength(3);
    expect(bus.since("a", first.id)).toHaveLength(2);
  });

  it("repairs an incomplete trailing event before appending", async () => {
    const projectsDirectory = await mkdtemp(path.join(tmpdir(), "open-game-events-"));
    const projectDirectory = path.join(projectsDirectory, "a");
    await mkdir(projectDirectory, { recursive: true });
    const valid = {
      id: 1,
      projectId: "a",
      type: "preview.starting",
      timestamp: new Date(0).toISOString(),
      data: {},
    };
    await writeFile(path.join(projectDirectory, "events.jsonl"), `${JSON.stringify(valid)}\n{"id":2`);
    const bus = new RuntimeEventBus(1_000, projectsDirectory);

    await bus.load(["a"]);
    bus.publish("a", "preview.stopped", {});
    await bus.flush();

    const lines = (await readFile(path.join(projectDirectory, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([1, 2]);
  });

  it("compacts a growing event log to the replay window", async () => {
    const projectsDirectory = await mkdtemp(path.join(tmpdir(), "open-game-events-"));
    await mkdir(path.join(projectsDirectory, "a"), { recursive: true });
    const bus = new RuntimeEventBus(2, projectsDirectory);
    for (let index = 0; index < 5; index++) bus.publish("a", "preview.starting", {});

    await bus.flush();

    const lines = (await readFile(path.join(projectsDirectory, "a", "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([4, 5]);
  });
});
