// @vitest-environment happy-dom
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentPlayableSurfaceHost } from "../src/shared/playable-sandbox.js";
import {
  NodeRuntime,
  MemoryPlayableSaveStore,
} from "../src/shared/playable-runtime.js";
import { createNodeGraphFixture } from "./playable-fixture.js";
import type { PlayableNodeContext } from "../src/shared/playable-nodes.js";

const moduleUrl = pathToFileURL(
  path.resolve("test/fixtures/playable-transition-page.mjs"),
).href;
let runtime: NodeRuntime;
let host: DocumentPlayableSurfaceHost;
const contexts = new Map<string, Omit<PlayableNodeContext, "root">>();
const surfaces = new Map<string, HTMLElement>();

afterEach(async () => {
  await runtime?.dispose();
  host?.destroy();
  contexts.clear();
  surfaces.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(target: string, prepare?: (root: ShadowRoot) => void) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: URL) =>
        new Response(
          url.pathname.includes("menu") ? "<main>Menu</main>" : target,
        ),
    ),
  );
  host = new DocumentPlayableSurfaceHost(
    document,
    undefined,
    (root) => {
      prepare?.(root);
      const element = root.host as HTMLElement;
      surfaces.set(element.dataset.playableSurface!, element);
      return () => {};
    },
    { base: new URL("https://story.test/") },
  );
  const mountNode = host.mountNode.bind(host);
  vi.spyOn(host, "mountNode").mockImplementation((surface, context) => {
    contexts.set(surface.id, context);
    return mountNode(surface, context);
  });
  const graph = createNodeGraphFixture();
  runtime = new NodeRuntime({
    graph,
    compiled: {
      version: 1,
      nodes: Object.fromEntries(
        graph.nodes.map((node) => [
          node.id,
          {
            id: node.id,
            html: node.source.html,
            css: "data:text/css,",
            javascript: moduleUrl,
            inputs: [],
          },
        ]),
      ),
    },
    graphSignature: "transition-test",
    surfaceHost: host,
    saveStore: new MemoryPlayableSaveStore(),
    assetUrls: {},
  });
  const started = runtime.start();
  const menu = await surface("menu");
  menu.shadowRoot!.querySelector("link")!.dispatchEvent(new Event("load"));
  await started;
  return menu;
}

async function surface(id: string): Promise<HTMLElement> {
  await vi.waitFor(() => expect(surfaces.has(id)).toBe(true));
  return surfaces.get(id)!;
}

it("retains the outgoing picture through stylesheet loading and image decoding", async () => {
  let decoded!: () => void;
  const decoding = new Promise<void>((resolve) => {
    decoded = resolve;
  });
  const menu = await setup(
    '<div data-media="backdrop"><img src="next.png"></div>',
    (root) => {
      const image = root.querySelector("img");
      if (!image) return;
      Object.defineProperty(image, "complete", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(image, "decode", { value: vi.fn(() => decoding) });
    },
  );
  const navigation = contexts.get("menu")!.navigation.emit("start");
  const lobby = await surface("lobby");
  expect(menu.isConnected).toBe(true);
  expect(menu.inert).toBe(true);
  expect(contexts.get("menu")!.lifecycle.signal.aborted).toBe(false);
  expect(lobby.style.opacity).toBe("0");
  expect(lobby.inert).toBe(true);
  const image = lobby.shadowRoot!.querySelector("img")!;
  lobby.shadowRoot!.querySelector("link")!.dispatchEvent(new Event("load"));
  await vi.waitFor(() => expect(image.decode).toHaveBeenCalled());
  expect(menu.shadowRoot!.textContent).toContain("Menu");
  expect(lobby.style.opacity).toBe("0");
  expect(() => contexts.get("menu")!.state.get()).toThrowError(
    expect.objectContaining({ code: "stale-surface" }),
  );
  decoded();
  await navigation;
  expect(menu.isConnected).toBe(false);
  expect(menu.shadowRoot!.childNodes).toHaveLength(0);
  expect(lobby.style.opacity).toBe("1");
  expect(lobby.inert).toBe(false);
});

it("waits for the video frame at the seek position and stops outgoing media", async () => {
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => {});
  const menu = await setup(
    '<div data-media="backdrop"><video src="next.mp4"></video></div>',
  );
  const previousVideo = document.createElement("video");
  menu.shadowRoot!.append(previousVideo);
  const navigation = contexts.get("menu")!.navigation.emit("start");
  const lobby = await surface("lobby");
  expect(pause).toHaveBeenCalledOnce();
  const video = lobby.shadowRoot!.querySelector("video")!;
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 2 },
    seeking: { configurable: true, value: true },
  });
  lobby.shadowRoot!.querySelector("link")!.dispatchEvent(new Event("load"));
  await vi.waitFor(() => expect(lobby.dataset.mounted).toBe("true"));
  video.dispatchEvent(new Event("loadeddata"));
  expect(menu.isConnected).toBe(true);
  expect(lobby.style.opacity).toBe("0");
  Object.defineProperty(video, "seeking", { value: false });
  video.dispatchEvent(new Event("seeked"));
  await navigation;
  expect(menu.isConnected).toBe(false);
  expect(lobby.style.opacity).toBe("1");
});

it("cleans both surfaces when the target fails to mount", async () => {
  const menu = await setup("<main data-fail></main>");
  const outcome = contexts
    .get("menu")!
    .navigation.emit("start")
    .catch((error: unknown) => error);
  const lobby = await surface("lobby");
  lobby.shadowRoot!.querySelector("link")!.dispatchEvent(new Event("load"));
  expect(String(await outcome)).toContain("Target mount failed");
  expect(menu.isConnected).toBe(false);
  expect(lobby.isConnected).toBe(false);
  expect(runtime.snapshot().status).toBe("failed");
});

it("cancels media readiness and cleans both surfaces when disposed", async () => {
  const menu = await setup(
    '<div data-media="backdrop"><video src="next.mp4"></video></div>',
  );
  const outcome = contexts
    .get("menu")!
    .navigation.emit("start")
    .catch((error: unknown) => error);
  const lobby = await surface("lobby");
  lobby.shadowRoot!.querySelector("link")!.dispatchEvent(new Event("load"));
  // Let mount settle and begin waiting for the video's first frame.
  await vi.waitFor(() => expect(lobby.dataset.mounted).toBe("true"));
  await runtime.dispose();
  expect(await outcome).toBeInstanceOf(Error);
  expect(menu.isConnected).toBe(false);
  expect(lobby.isConnected).toBe(false);
  expect(runtime.snapshot().status).toBe("disposed");
});

it("retains the outgoing picture when abort cleanup clears its DOM", async () => {
  const menu = await setup(
    '<div data-media="backdrop"><video src="next.mp4"></video></div>',
  );
  contexts
    .get("menu")!
    .lifecycle.signal.addEventListener(
      "abort",
      () => menu.shadowRoot!.replaceChildren(),
      { once: true },
    );
  const navigation = contexts.get("menu")!.navigation.emit("start");
  const lobby = await surface("lobby");
  expect(menu.isConnected).toBe(true);
  expect(menu.shadowRoot!.textContent).toContain("Menu");
  expect(lobby.style.opacity).toBe("0");
  lobby.shadowRoot!.querySelector("link")!.dispatchEvent(new Event("load"));
  const video = lobby.shadowRoot!.querySelector("video")!;
  Object.defineProperty(video, "readyState", { value: 2 });
  video.dispatchEvent(new Event("loadeddata"));
  await navigation;
  expect(contexts.get("menu")!.lifecycle.signal.aborted).toBe(true);
  expect(menu.shadowRoot!.childNodes).toHaveLength(0);
});

it("keeps incoming controls and media inactive until outgoing async cleanup finishes", async () => {
  const mediaControls = new Map<
    string,
    { pause: () => void; play: () => Promise<void> }
  >();
  await setup(
    '<div data-media="backdrop"><video src="incoming.mp4"></video></div>',
    (root) => {
      const video = root.querySelector("video");
      if (!video) return;
      let paused = false;
      Object.defineProperties(video, {
        readyState: { value: 2 },
        paused: { get: () => paused },
      });
      const pause = vi.spyOn(video, "pause").mockImplementation(() => {
        paused = true;
      });
      const play = vi.spyOn(video, "play").mockImplementation(async () => {
        paused = false;
      });
      mediaControls.set((root.host as HTMLElement).dataset.playableSurface!, {
        pause: video.pause,
        play: video.play,
      });
    },
  );
  const originalMount = host.mountNode.bind(host);
  let finishCleanup!: () => void;
  const pendingCleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  vi.spyOn(host, "mountNode").mockImplementation(async (surface, context) => {
    const mounted = await originalMount(surface, context);
    if (surface.id === "lobby")
      return { ...mounted, cleanup: () => pendingCleanup };
    return mounted;
  });
  try {
    const first = contexts.get("menu")!.navigation.emit("start");
    const lobby = await surface("lobby");
    lobby.shadowRoot!.querySelector("link")!.dispatchEvent(new Event("load"));
    await first;
    const outgoingUpdates = vi.fn();
    contexts.get("lobby")!.state.subscribe(outgoingUpdates);
    const second = contexts.get("lobby")!.navigation.emit("archive");
    const archive = await surface("archive");
    archive.shadowRoot!.querySelector("link")!.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(archive.style.opacity).toBe("1"));
    const { pause, play } = mediaControls.get("archive")!;
    expect(pause).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
    expect(archive.inert).toBe(true);
    await contexts.get("archive")!.state.set("hasKey", true);
    expect(outgoingUpdates).not.toHaveBeenCalled();
    finishCleanup();
    await second;
    expect(archive.inert).toBe(false);
    expect(play).toHaveBeenCalledOnce();
  } finally {
    finishCleanup();
  }
});
