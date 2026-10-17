// @vitest-environment happy-dom
import path from "node:path";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRuntimeState } from "../src/shared/desktop-runtime.js";
import type {
  CheckpointChangeItem,
  ConversationDetail,
  RuntimeEvent,
  RuntimeEventData,
  RuntimeEventType,
  TurnChanges,
} from "../src/shared/contracts.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock(CODING_WORKSPACE);
});

const READY: DesktopRuntimeState = {
  status: "ready",
  generation: 1,
  recovered: false,
  runtime: { url: "http://127.0.0.1:1001", token: "token" },
};
const BASE =
  "/projects/project/conversations/conversation/checkpoints/checkpoint-1";
const UNFINISHED = "/projects/project/checkpoints/unfinished";
const CODING_WORKSPACE = path.resolve("src/renderer/coding-workspace.tsx");
const CHANGES: CheckpointChangeItem[] = [
  { path: "a.js", kind: "modified", state: "applied" },
  { path: "b.js", kind: "added", state: "applied" },
];

function detail(turnId: string, changes?: TurnChanges): ConversationDetail {
  const timestamp = new Date(0).toISOString();
  return {
    conversation: {
      id: "conversation",
      projectId: "project",
      title: "Chat",
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 2,
    },
    cursor: 0,
    agent: { status: "idle" },
    settings: {},
    plan: { mode: "normal" },
    pendingPrompts: [],
    turns: [
      {
        id: turnId,
        conversationId: "conversation",
        status: "completed",
        items: [
          {
            id: `${turnId}:user`,
            turnId,
            type: "userMessage",
            text: "Build",
            checkpointId: "checkpoint-1",
            ...(changes ? { changes } : {}),
          },
          {
            id: `${turnId}:answer`,
            turnId,
            type: "agentMessage",
            text: "Built",
            status: "completed",
            phase: "final_answer",
          },
        ],
      },
    ],
  };
}

/** A daemon that answers the routes the shell needs, with `routes` deciding the checkpoint ones. */
async function openProject(
  routes: (
    route: string,
    init: RequestInit,
  ) => Response | Promise<Response> | undefined,
  conversation = detail("live-turn", { files: 2 }),
) {
  Object.defineProperty(window, "ohMyGameDesktop", {
    configurable: true,
    value: {
      platform: "darwin",
      runtime: { daemonUrl: "http://127.0.0.1:1000", token: "old-token" },
      runtimeService: {
        state: vi.fn(),
        restart: vi.fn(),
        onState: vi.fn(() => () => {}),
      },
    },
  });
  const daemon = {
    conversation,
    requests: [] as { route: string; method: string; body?: string }[],
    events: undefined as
      ReadableStreamDefaultController<Uint8Array> | undefined,
    send<T extends RuntimeEventType>(
      id: number,
      type: T,
      data: RuntimeEventData[T],
      conversationId?: string,
      turnId?: string,
    ) {
      const event = {
        id,
        projectId: "project",
        ...(conversationId ? { conversationId } : {}),
        ...(turnId ? { turnId } : {}),
        type,
        timestamp: new Date(0).toISOString(),
        data,
      } as RuntimeEvent<T>;
      this.events!.enqueue(
        new TextEncoder().encode(
          `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      );
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const { pathname, search } = new URL(url);
      const route = pathname + search;
      if (pathname.endsWith("/events"))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              daemon.events = controller;
              init.signal!.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      daemon.requests.push({
        route,
        method: init.method ?? "GET",
        ...(init.body ? { body: String(init.body) } : {}),
      });
      return (
        routes(route, init) ??
        Response.json(
          pathname === "/projects/project"
            ? {
                id: "project",
                name: "Test",
                type: "general",
                webPreviewEnabled: false,
                workspacePath: "/tmp/project",
                updatedAt: new Date(0).toISOString(),
                preview: { status: "stopped" },
              }
            : pathname.endsWith("/conversations")
              ? [daemon.conversation.conversation]
              : pathname.endsWith("/conversations/conversation")
                ? daemon.conversation
                : pathname.endsWith("/checkpoints/unfinished")
                  ? { unfinished: false }
                  : pathname.endsWith("/checkpoint-1/changes")
                    ? { changes: CHANGES }
                    : pathname.endsWith("/models") ||
                        pathname.endsWith("/catalog")
                      ? { models: [], providers: [] }
                      : pathname.includes("capabilities")
                        ? { plugins: [], skills: [] }
                        : [],
        )
      );
    }),
  );
  const { updateRuntimeConnection } =
    await import("../src/renderer/runtime-connection.js");
  const { ProjectShell } = await import("../src/renderer/project-shell.js");
  const { AuthProvider } = await import("../src/renderer/auth.js");
  updateRuntimeConnection(READY);
  await act(async () =>
    root.render(
      <AuthProvider>
        <ProjectShell
          projectId="project"
          conversationId="conversation"
          onOpenConversation={() => {}}
          onHome={() => {}}
        />
      </AuthProvider>,
    ),
  );
  await settle();
  return daemon;
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
  );
const buttons = () =>
  [...container.querySelectorAll("button")].map(
    (candidate) => candidate.textContent,
  );
const texts = (selector: string) =>
  [...container.querySelectorAll(selector)].map(
    (element) => element.textContent,
  );
async function click(name: string) {
  await act(async () => button(name)!.click());
  await settle();
}

describe("checkpoints in the project shell", () => {
  it("undoes a turn through the conflict choice and marks it without reading the conversation again", async () => {
    const daemon = await openProject((route, init) => {
      if (route === `${BASE}/changes`)
        return Response.json({
          changes: [
            { path: "a.js", kind: "modified", state: "changed" },
            { path: "b.js", kind: "added", state: "applied" },
          ],
        });
      if (route !== `${BASE}/undo`) return undefined;
      return init.body === "{}"
        ? Response.json(
            {
              error: "Files were changed after this turn",
              conflicts: ["a.js"],
            },
            { status: 409 },
          )
        : Response.json({ changed: ["b.js"], conflicts: ["a.js"] });
    });
    const asked = (route: string) =>
      daemon.requests.filter((request) => request.route.startsWith(route))
        .length;

    await click("2 files changed");
    expect(texts(".turn-change-row")).toEqual(["a.js—Changed later", "b.js—"]);

    await click("Undo");
    expect(texts(".turn-changes-conflicts li")).toEqual(["a.js"]);

    await click("Keep them");
    expect(
      daemon.requests.filter((request) => request.route === `${BASE}/undo`),
    ).toEqual([
      { route: `${BASE}/undo`, method: "POST", body: "{}" },
      {
        route: `${BASE}/undo`,
        method: "POST",
        body: JSON.stringify({ conflicts: "keep" }),
      },
    ]);
    expect(container.querySelector(".turn-changes-result")!.textContent).toBe(
      "1 file was put back. 1 file was left as it is.",
    );

    const fileLists = asked("/projects/project/files");
    const changeLists = asked(`${BASE}/changes`);
    await act(async () =>
      daemon.send(
        1,
        "workspace.undone",
        { checkpointId: "checkpoint-1", kept: 1 },
        "conversation",
      ),
    );
    await settle();

    // The event marks the turn. The conversation is not read for it.
    expect(asked("/projects/project/conversations/conversation?reset=1")).toBe(
      0,
    );
    expect(container.querySelector(".turn-changes-undone")!.textContent).toBe(
      "Partly undone",
    );
    expect(button("Undo")).toBeUndefined();
    expect(button("Undo the rest")).toBeDefined();
    // The turn marker does not also invalidate files. The project-wide event
    // updates every editor and the open list once, after the lock is released.
    expect(asked("/projects/project/files")).toBe(fileLists);
    expect(asked(`${BASE}/changes`)).toBe(changeLists);
    await act(async () =>
      daemon.send(2, "workspace.restored", {
        version: "restored",
        changed: ["a.js"],
      }),
    );
    await settle();
    expect(asked("/projects/project/files")).toBeGreaterThan(fileLists);
    expect(asked(`${BASE}/changes`)).toBe(changeLists + 1);
    expect(container.querySelector(".turn-changes-result")!.textContent).toBe(
      "1 file was put back. 1 file was left as it is.",
    );
    expect(button("2 files changed")!.getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("reapplies a turn, updates editors through SSE, and keeps the current conversation", async () => {
    const daemon = await openProject((route) => {
      if (route === `${BASE}/undo`)
        return Response.json({
          changed: ["a.js", "b.js"],
          conflicts: [],
          undone: true,
          kept: 0,
        });
      if (route === `${BASE}/reapply`)
        return Response.json({
          changed: ["a.js", "b.js"],
          conflicts: [],
          undone: false,
          kept: 0,
        });
      return undefined;
    });
    await click("2 files changed");
    await click("Undo");
    expect(button("Reapply")).toBeDefined();
    await act(async () =>
      daemon.send(
        1,
        "workspace.undone",
        { checkpointId: "checkpoint-1", kept: 0 },
        "conversation",
      ),
    );
    await settle();
    await click("Reapply");
    expect(
      daemon.requests.filter((request) => request.route === `${BASE}/reapply`),
    ).toEqual([{ route: `${BASE}/reapply`, method: "POST", body: "{}" }]);
    expect(button("Reapply")).toBeUndefined();
    expect(button("Undo")).toBeDefined();
    expect(container.querySelector(".turn-changes-result")!.textContent).toBe(
      "2 files reapplied.",
    );
    const fileReads = daemon.requests.filter(
      (request) => request.route === "/projects/project/files",
    ).length;
    await act(async () =>
      daemon.send(
        2,
        "workspace.reapplied",
        { checkpointId: "checkpoint-1", undone: false, kept: 0 },
        "conversation",
      ),
    );
    await act(async () =>
      daemon.send(3, "workspace.restored", {
        version: "reapplied",
        changed: ["a.js", "b.js"],
      }),
    );
    await settle();
    expect(
      daemon.requests.filter(
        (request) => request.route === "/projects/project/files",
      ).length,
    ).toBeGreaterThan(fileReads);
    expect(
      daemon.requests.some((request) => request.route.includes("?reset=1")),
    ).toBe(false);
    expect(container.textContent).toContain("Built");
  });

  it("keeps a turn that started while an undo was reported", async () => {
    const stored = {
      ...detail("stored-turn", { files: 2, undone: true }),
      cursor: 1,
    };
    const held: Array<() => void> = [];
    // A conversation read for the undo would be answered only after the next turn started.
    const daemon = await openProject((route) =>
      route.endsWith("?reset=1")
        ? new Promise<Response>((resolve) => {
            held.push(() => resolve(Response.json(stored)));
          })
        : undefined,
    );

    await act(async () =>
      daemon.send(
        1,
        "workspace.undone",
        { checkpointId: "checkpoint-1", kept: 0 },
        "conversation",
      ),
    );
    await settle();
    await act(async () => {
      daemon.send(
        2,
        "agent.started",
        { prompt: "Next thing" },
        "conversation",
        "turn-2",
      );
      daemon.send(
        3,
        "checkpoint.created",
        { checkpointId: "checkpoint-2" },
        "conversation",
        "turn-2",
      );
    });
    await settle();
    await act(async () => held.forEach((answer) => answer()));
    await settle();
    await act(async () => {
      daemon.send(4, "agent.completed", {}, "conversation", "turn-2");
      daemon.send(
        5,
        "checkpoint.completed",
        { checkpointId: "checkpoint-2", files: 3 },
        "conversation",
        "turn-2",
      );
    });
    await settle();

    expect(held).toHaveLength(0);
    expect(texts(".user-message")).toEqual(["Build", "Next thing"]);
    expect(texts(".turn-changes-summary")).toEqual([
      "2 files changed",
      "3 files changed",
    ]);
  });

  it("does not mark a turn for an undo in another conversation, and reads no conversation for a restore without one", async () => {
    const daemon = await openProject(() => undefined);
    await click("2 files changed");
    const loads = () =>
      daemon.requests.filter(
        (request) =>
          request.route === "/projects/project/conversations/conversation" ||
          request.route.startsWith(
            "/projects/project/conversations/conversation?",
          ),
      ).length;
    const before = loads();

    // A checkpoint id is unique only within its conversation.
    await act(async () =>
      daemon.send(
        1,
        "workspace.undone",
        { checkpointId: "checkpoint-1", kept: 0 },
        "another",
      ),
    );
    await act(async () =>
      daemon.send(2, "workspace.restored", {
        version: "restored",
        changed: [],
      }),
    );
    await settle();

    expect(loads()).toBe(before);
    expect(button("Undo")).toBeDefined();
    expect(container.textContent).not.toContain("Changes undone");
  });

  it("reads the conversation again after a restore in it", async () => {
    const daemon = await openProject(() => undefined);

    daemon.conversation = { ...detail("stored-turn"), cursor: 1 };
    await act(async () =>
      daemon.send(
        1,
        "workspace.restored",
        { checkpointId: "checkpoint-1", version: "restored", changed: [] },
        "conversation",
      ),
    );
    await settle();

    expect(daemon.requests).toContainEqual({
      route: "/projects/project/conversations/conversation?reset=1",
      method: "GET",
    });
    expect(container.querySelector(".turn-changes")).toBeNull();
  });

  it("shows the row as soon as the end of a turn is reported, and reads an open list again when files changed", async () => {
    let changes = CHANGES;
    const daemon = await openProject(
      (route) =>
        route === `${BASE}/changes` ? Response.json({ changes }) : undefined,
      detail("live-turn"),
    );
    expect(container.querySelector(".turn-changes")).toBeNull();

    await act(async () =>
      daemon.send(
        1,
        "checkpoint.completed",
        { checkpointId: "checkpoint-1", files: 2 },
        "conversation",
      ),
    );
    await settle();

    expect(button("Undo")).toBeUndefined();
    await click("2 files changed");
    expect(button("Undo")).toBeDefined();
    expect(texts(".turn-change-row")).toEqual(["a.js—", "b.js—"]);

    // A later turn rewrites one of the files.
    changes = [{ ...CHANGES[0], state: "changed" }, CHANGES[1]];
    await act(async () =>
      daemon.send(
        2,
        "agent.started",
        { prompt: "Next thing" },
        "conversation",
        "turn-2",
      ),
    );
    await act(async () =>
      daemon.send(3, "agent.completed", {}, "conversation", "turn-2"),
    );
    await settle();

    expect(texts(".turn-change-row")).toEqual(["a.js—Changed later", "b.js—"]);
    expect(
      daemon.requests.filter((request) => request.route === `${BASE}/changes`),
    ).toHaveLength(2);
  });

  it("offers no undo while the Agent works or the connection is lost", async () => {
    const daemon = await openProject(() => undefined);
    await click("2 files changed");
    expect(button("Undo")!.disabled).toBe(false);

    await act(async () =>
      daemon.send(
        1,
        "agent.started",
        { prompt: "Next thing" },
        "conversation",
        "turn-2",
      ),
    );
    await settle();

    expect(button("Undo")!.disabled).toBe(true);
    // Looking at the changes stays possible.
    expect(button("2 files changed")!.disabled).toBe(false);

    await act(async () =>
      daemon.send(2, "agent.completed", {}, "conversation", "turn-2"),
    );
    await settle();
    expect(button("Undo")!.disabled).toBe(false);

    await act(async () => daemon.events!.close());
    await settle();
    expect(button("Undo")!.disabled).toBe(true);
  });

  it("overwrites only the files that were shown, and asks again when more were changed", async () => {
    const answers = [
      Response.json(
        { error: "Files were changed after this turn", conflicts: ["a.js"] },
        { status: 409 },
      ),
      Response.json(
        {
          error: "Files were changed after this turn",
          conflicts: ["a.js", "b.js"],
        },
        { status: 409 },
      ),
      Response.json(
        {
          error: "These files cannot be put back",
          conflicts: ["a.js"],
          blocked: true,
        },
        { status: 409 },
      ),
    ];
    const daemon = await openProject((route) =>
      route === `${BASE}/undo` ? answers.shift() : undefined,
    );
    await click("2 files changed");
    await click("Undo");
    expect(texts(".turn-changes-conflicts li")).toEqual(["a.js"]);

    await click("Overwrite them");

    expect(texts(".turn-changes-conflicts li")).toEqual(["a.js", "b.js"]);
    expect(
      container.querySelector(".turn-changes-panel")!.textContent,
    ).toContain(
      "More files were changed in the meantime, so nothing was overwritten.",
    );
    expect(container.querySelector(".turn-changes-result")).toBeNull();

    await click("Overwrite them");

    expect(
      daemon.requests
        .filter((request) => request.route === `${BASE}/undo`)
        .map((request) => request.body),
    ).toEqual([
      "{}",
      JSON.stringify({ conflicts: "overwrite", expected: ["a.js"] }),
      JSON.stringify({ conflicts: "overwrite", expected: ["a.js", "b.js"] }),
    ]);
    // A file that can never be put back is not offered for overwriting again.
    expect(
      container.querySelector(".turn-changes-panel")!.textContent,
    ).toContain(
      "These files cannot be put back because other files are in their place:",
    );
    expect(buttons()).toContain("Undo the rest");
    expect(buttons()).not.toContain("Overwrite them");
  });

  it("saves the design before it undoes", async () => {
    let saved!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    vi.doMock(CODING_WORKSPACE, () => ({
      CodingWorkspace: ({
        onDesignSaveReady,
      }: {
        onDesignSaveReady: (save: (() => Promise<void>) | undefined) => void;
      }) => {
        useEffect(() => onDesignSaveReady(save), [onDesignSaveReady]);
        return null;
      },
    }));
    const daemon = await openProject((route) =>
      route === `${BASE}/undo`
        ? Response.json({ changed: ["a.js", "b.js"], conflicts: [] })
        : undefined,
    );
    const undone = () =>
      daemon.requests.filter((request) => request.route === `${BASE}/undo`)
        .length;

    await click("2 files changed");
    await click("Undo");

    // Unsaved edits must be on disk before conflicts are worked out.
    expect(save).toHaveBeenCalledTimes(1);
    expect(undone()).toBe(0);

    await act(async () => saved());
    await settle();
    expect(undone()).toBe(1);
    expect(container.querySelector(".turn-changes-result")!.textContent).toBe(
      "2 files were put back.",
    );
  });

  it("asks before it puts the files back after a restore that was cut off, and shows why that failed", async () => {
    let refuse = true;
    const daemon = await openProject((route, init) => {
      if (route === UNFINISHED) return Response.json({ unfinished: true });
      if (route === `${UNFINISHED}/changes`)
        return Response.json({
          changes: [
            { path: "level2.js", kind: "removed" },
            { path: "notes.txt", kind: "modified" },
            { path: "old.js", kind: "added" },
          ],
        });
      if (route !== `${UNFINISHED}/restore` || init.method !== "POST")
        return undefined;
      return refuse
        ? Response.json(
            { error: "Wait for the agent to finish" },
            { status: 409 },
          )
        : new Response(null, { status: 204 });
    });
    const banner = () => container.querySelector(".unfinished-restore");
    const restores = () =>
      daemon.requests.filter(
        (request) => request.route === `${UNFINISHED}/restore`,
      ).length;

    expect(banner()!.getAttribute("role")).toBe("status");
    expect(banner()!.textContent).toContain(
      "Putting files back was interrupted, so the project's files may be partly changed.",
    );

    await click("Put the files back");

    // Nothing is put back before the user saw what that does.
    expect(restores()).toBe(0);
    expect(banner()!.textContent).toContain(
      "3 files will be put back to how they were before the interruption. Later changes to these files will be lost.",
    );
    expect(texts(".unfinished-restore-files li")).toEqual([
      "Removedlevel2.js",
      "Changed backnotes.txt",
      "Comes backold.js",
    ]);
    expect(button("Put the files back")).toBeUndefined();

    await click("Put 3 files back");
    expect(banner()!.querySelector('[role="alert"]')!.textContent).toBe(
      "Wait for the agent to finish",
    );
    expect(restores()).toBe(1);

    // After a failure the list is read again before the user is asked.
    refuse = false;
    await click("Put the files back");
    await click("Put 3 files back");
    expect(banner()).toBeNull();
    expect(restores()).toBe(2);
    expect(
      daemon.requests.filter(
        (request) => request.route === `${UNFINISHED}/changes`,
      ),
    ).toHaveLength(2);
  });

  it("names at most ten of the files it would put back, and hides the offer on request", async () => {
    const daemon = await openProject((route) =>
      route === UNFINISHED
        ? Response.json({ unfinished: true })
        : route === `${UNFINISHED}/changes`
          ? Response.json({
              changes: Array.from({ length: 12 }, (_, index) => ({
                path: `file-${index + 1}.js`,
                kind: "modified",
              })),
            })
          : undefined,
    );

    await click("Put the files back");

    expect(texts(".unfinished-restore-files li")).toEqual([
      ...Array.from(
        { length: 10 },
        (_, index) => `Changed backfile-${index + 1}.js`,
      ),
      "and 2 more",
    ]);
    expect(button("Put 12 files back")).toBeDefined();

    await click("Not now");

    expect(container.querySelector(".unfinished-restore")).toBeNull();
    expect(
      daemon.requests.filter(
        (request) => request.route === `${UNFINISHED}/restore`,
      ),
    ).toHaveLength(0);
  });

  it("words the offer for a single file, and asks again once the files changed", async () => {
    const daemon = await openProject((route) =>
      route === UNFINISHED
        ? Response.json({ unfinished: true })
        : route === `${UNFINISHED}/changes`
          ? Response.json({
              changes: [{ path: "notes.txt", kind: "modified" }],
            })
          : undefined,
    );

    await click("Put the files back");
    expect(
      container.querySelector(".unfinished-restore")!.textContent,
    ).toContain(
      "1 file will be put back to how it was before the interruption. Later changes to this file will be lost.",
    );
    expect(button("Put 1 file back")!.disabled).toBe(false);

    // While the Agent works nothing can be put back.
    await act(async () =>
      daemon.send(
        1,
        "agent.started",
        { prompt: "Next thing" },
        "conversation",
        "turn-2",
      ),
    );
    await settle();
    expect(button("Put 1 file back")!.disabled).toBe(true);
    expect(button("Not now")!.disabled).toBe(false);

    // What it wrote is not in the list the user was shown.
    await act(async () =>
      daemon.send(2, "agent.completed", {}, "conversation", "turn-2"),
    );
    await settle();
    expect(button("Put 1 file back")).toBeUndefined();
    expect(button("Put the files back")!.disabled).toBe(false);
  });

  it("says so when no file needs to be put back, and clears the offer on request", async () => {
    const daemon = await openProject((route) =>
      route === UNFINISHED
        ? Response.json({ unfinished: true })
        : route === `${UNFINISHED}/changes`
          ? Response.json({ changes: [] })
          : route === `${UNFINISHED}/restore`
            ? new Response(null, { status: 204 })
            : undefined,
    );

    await click("Put the files back");
    expect(
      container.querySelector(".unfinished-restore")!.textContent,
    ).toContain("The files are already as they were before the interruption.");
    expect(button("Put 0 files back")).toBeUndefined();
    expect(button("Not now")).toBeUndefined();

    // The mark is still there for the next start, so it is taken away by the daemon.
    await click("OK");
    expect(
      daemon.requests.filter(
        (request) => request.route === `${UNFINISHED}/restore`,
      ),
    ).toHaveLength(1);
    expect(container.querySelector(".unfinished-restore")).toBeNull();
  });

  it.each(["changes", "restore"])(
    "hides the offer without an error when the %s request finds nothing unfinished any more",
    async (missing) => {
      await openProject((route) =>
        route === UNFINISHED
          ? Response.json({ unfinished: true })
          : route === `${UNFINISHED}/${missing}`
            ? Response.json(
                { error: "No restore or undo was left unfinished" },
                { status: 404 },
              )
            : route === `${UNFINISHED}/changes`
              ? Response.json({
                  changes: [{ path: "notes.txt", kind: "modified" }],
                })
              : undefined,
      );

      await click("Put the files back");
      if (missing === "restore") await click("Put 1 file back");

      expect(container.querySelector(".unfinished-restore")).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("shows in the banner why the files to put back could not be listed", async () => {
    await openProject((route) =>
      route === UNFINISHED
        ? Response.json({ unfinished: true })
        : route === `${UNFINISHED}/changes`
          ? Response.json(
              { error: "The checkpoint store could not be read" },
              { status: 500 },
            )
          : undefined,
    );

    await click("Put the files back");

    expect(
      container.querySelector('.unfinished-restore [role="alert"]')!
        .textContent,
    ).toBe("The checkpoint store could not be read");
    expect(button("Put the files back")!.disabled).toBe(false);
  });

  it("shows the banner when an undo left the workspace partly changed, until a later one runs to its end", async () => {
    const daemon = await openProject((route) =>
      route === `${BASE}/undo`
        ? Response.json(
            {
              error: "The undo could not be completed",
              code: "CHECKPOINT_INCOMPLETE",
            },
            { status: 409 },
          )
        : undefined,
    );
    expect(container.querySelector(".unfinished-restore")).toBeNull();

    await click("2 files changed");
    await click("Undo");

    expect(container.querySelector(".turn-changes-error")!.textContent).toBe(
      "The undo could not be completed",
    );
    expect(container.querySelector(".unfinished-restore")).not.toBeNull();

    await act(async () =>
      daemon.send(1, "workspace.restored", {
        version: "restored",
        changed: [],
      }),
    );
    await settle();
    expect(container.querySelector(".unfinished-restore")).toBeNull();
  });

  it("shows the banner when a restore left the workspace partly changed", async () => {
    await openProject((route) =>
      route === `${BASE}/restore`
        ? Response.json(
            {
              error: "The restore could not be completed",
              code: "CHECKPOINT_INCOMPLETE",
            },
            { status: 409 },
          )
        : undefined,
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Restore to before this message"]',
        )!
        .click(),
    );
    await settle();

    expect(container.querySelector(".unfinished-restore")).not.toBeNull();
  });
});
