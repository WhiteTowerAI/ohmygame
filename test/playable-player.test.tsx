// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodePlayer } from "../src/renderer/playable-player.js";
import type { NodePlayerDefinition } from "../src/shared/playable-player-protocol.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeDefinition(title: string): NodePlayerDefinition {
  const codebase = createStarterCodebaseWithScene(title, { width: 1280, height: 720 });
  return {
    version: 1,
    graph: codebase.graph,
    graphSignature: `sig-${title}`,
    hashes: {},
  };
}

describe("NodePlayer", () => {
  it("resets ready/error on reload, validates message origins, and targets pageOrigin", async () => {
    const page = "http://127.0.0.1:43999/index.html";
    const defA = makeDefinition("Scene A");
    const defB = makeDefinition("Scene B");
    const render = async (definition: NodePlayerDefinition) => {
      await act(async () => {
        root.render(
          <NodePlayer
            definition={definition}
            page={page}
            preview={{ startNodeId: definition.graph.entryNodeId }}
            tool="select"
            loadingLabel="Loading stage..."
          />,
        );
      });
    };

    await render(defA);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    expect(container.textContent).toContain("Loading stage...");
    const postMessage = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { postMessage },
    });
    const instanceA = new URL(iframe.src).searchParams.get("ohmygame-instance")!;
    expect(instanceA).toBeTruthy();

    // Message from a foreign origin must be ignored.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://evil.example",
          source: iframe.contentWindow,
          data: {
            kind: "ohmygame:playable:error",
            instanceId: instanceA,
            error: "Spoofed error",
          },
        }),
      );
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();

    // Real error from pageOrigin renders the error overlay.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://127.0.0.1:43999",
          source: iframe.contentWindow,
          data: {
            kind: "ohmygame:playable:error",
            instanceId: instanceA,
            error: "Broken script",
          },
        }),
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Broken script");

    // Snapshot from pageOrigin marks ready and sends pick-start targeting pageOrigin.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://127.0.0.1:43999",
          source: iframe.contentWindow,
          data: {
            kind: "ohmygame:playable:snapshot",
            instanceId: instanceA,
            snapshot: {
              currentNodeId: defA.graph.entryNodeId,
              canBack: false,
              backStack: [],
              state: {},
              save: { present: false },
              slots: [],
              seen: { nodes: {}, variants: {} },
              preferences: { muted: false, textSpeed: "normal" },
              errors: [],
            },
          },
        }),
      );
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(postMessage).toHaveBeenCalledWith(
      { kind: "ohmygame:playable:pick-start", instanceId: instanceA, tool: "select" },
      "http://127.0.0.1:43999",
    );

    // Reloading with a new definition resets ready & does NOT send stale pick-start before new snapshot.
    postMessage.mockClear();
    await render(defB);
    expect(container.textContent).toContain("Loading stage...");
    expect(postMessage).not.toHaveBeenCalled();

    const instanceB = new URL(iframe.src).searchParams.get("ohmygame-instance")!;
    expect(instanceB).not.toBe(instanceA);

    // Send snapshot for B -> now pick-start fires for instanceB.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://127.0.0.1:43999",
          source: iframe.contentWindow,
          data: {
            kind: "ohmygame:playable:snapshot",
            instanceId: instanceB,
            snapshot: {
              currentNodeId: defB.graph.entryNodeId,
              canBack: false,
              backStack: [],
              state: {},
              save: { present: false },
              slots: [],
              seen: { nodes: {}, variants: {} },
              preferences: { muted: false, textSpeed: "normal" },
              errors: [],
            },
          },
        }),
      );
    });
    expect(postMessage).toHaveBeenCalledWith(
      { kind: "ohmygame:playable:pick-start", instanceId: instanceB, tool: "select" },
      "http://127.0.0.1:43999",
    );
  });
});
