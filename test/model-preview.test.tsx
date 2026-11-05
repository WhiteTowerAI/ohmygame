// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelPreview } from "../src/renderer/model-preview.js";

/** The viewer's public playback and visibility API; GPU behavior is checked in Electron. */
/** Every model a viewer was put in the page for, since a viewer starts loading as it connects. */
const connected: Array<string | null> = [];
/** Runs as each viewer connects; the element's own callbacks are fixed when it is defined. */
let onConnect: ((viewer: ModelViewer) => void) | undefined;
class ModelViewer extends HTMLElement {
  static observedAttributes = ["auto-rotate"];
  connectedCallback() {
    connected.push(this.getAttribute("src"));
    onConnect?.(this);
  }
  loaded = false;
  availableAnimations = ["Walk", "Run"];
  autoplay = false;
  autoRotate = false;
  modelIsVisible = true;
  paused = true;
  currentTime = 1;
  play = vi.fn(() => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  attributeChangedCallback(
    _name: string,
    _before: string,
    value: string | null,
  ) {
    this.autoRotate = value !== null;
  }
  load() {
    this.loaded = true;
    if (this.autoplay) this.play();
    this.dispatchEvent(new Event("load"));
  }
  visible(value: boolean) {
    this.modelIsVisible = value;
    this.dispatchEvent(
      new CustomEvent("model-visibility", { detail: { visible: value } }),
    );
  }
}
customElements.define("model-viewer", ModelViewer);

/** happy-dom lays nothing out and its observer never reports; here everything is on screen. */
class OnScreen {
  readonly #callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) { this.#callback = callback; }
  observe(target: Element) {
    queueMicrotask(() => this.#callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  disconnect() {}
}

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let visibility: DocumentVisibilityState;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", OnScreen);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const viewer = () => container.querySelector<ModelViewer>("model-viewer")!;
const button = () => container.querySelector("button")!;
const click = () => act(async () => button().click());
async function render(source = "model.glb", controls = true) {
  await act(async () =>
    root.render(
      <ModelPreview source={source} label="Character" controls={controls} />,
    ),
  );
  await act(async () => viewer().load());
}

it("waits for the screen before it loads a model", async () => {
  const observed: Element[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    observe(target: Element) { observed.push(target); }
    disconnect() {}
  });
  await act(async () => root.render(<ModelPreview source="model.glb" label="Character" />));
  expect(observed).toHaveLength(1);
  expect(container.querySelector("model-viewer")).toBeNull();
  expect(container.textContent).toContain("Loading 3D model");
});

it("loads two models at a time, and the next as one finishes", async () => {
  await act(async () => root.render(<>
    {["a.glb", "b.glb", "c.glb"].map((source) => <ModelPreview key={source} source={source} label={source} />)}
  </>));
  const viewers = () => [...container.querySelectorAll<ModelViewer>("model-viewer")];
  expect(viewers().map((item) => item.getAttribute("src"))).toEqual(["a.glb", "b.glb"]);
  await act(async () => viewers()[0]!.load());
  expect(viewers().map((item) => item.getAttribute("src"))).toEqual(["a.glb", "b.glb", "c.glb"]);
  // A model that goes away gives up its turn too.
  await act(async () => root.render(<ModelPreview source="d.glb" label="d" />));
  await act(async () => root.render(<>
    {["e.glb", "f.glb"].map((source) => <ModelPreview key={source} source={source} label={source} />)}
  </>));
  expect(viewers().map((item) => item.getAttribute("src"))).toEqual(["e.glb", "f.glb"]);
});

it("makes a model whose source changes wait for a turn of its own", async () => {
  const show = (sources: string[]) => act(async () => root.render(<>
    {sources.map((source, index) => <ModelPreview key={index} source={source} label={source} />)}
  </>));
  const viewers = () => [...container.querySelectorAll<ModelViewer>("model-viewer")].map((item) => item.getAttribute("src"));
  await show(["a.glb", "b.glb", "c.glb"]);
  expect(viewers()).toEqual(["a.glb", "b.glb"]);
  // The first slot's new model gives its turn to the one already waiting.
  connected.length = 0;
  await show(["a2.glb", "b.glb", "c.glb"]);
  expect(viewers()).toEqual(["b.glb", "c.glb"]);
  expect(connected).not.toContain("a2.glb");
  await act(async () => container.querySelector<ModelViewer>('model-viewer[src="b.glb"]')!.load());
  expect(viewers()).toEqual(["a2.glb", "b.glb", "c.glb"]);
});

it("frees a turn for a model that fails as soon as its viewer connects", async () => {
  const failing = new Set(["a.glb", "b.glb"]);
  onConnect = (viewer) => {
    // As a revoked file would, before React's passive effects run.
    if (failing.has(viewer.getAttribute("src")!)) queueMicrotask(() => viewer.dispatchEvent(new CustomEvent("error", { detail: { type: "loadfailure" } })));
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Outside act, which would run passive effects straight after the commit.
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  root.render(<>
    {["a.glb", "b.glb", "c.glb"].map((source) => <ModelPreview key={source} source={source} label={source} />)}
  </>);
  await vi.waitFor(() => expect(container.querySelectorAll("model-viewer")).not.toHaveLength(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  onConnect = undefined;
  expect([...container.querySelectorAll("model-viewer")].map((item) => item.getAttribute("src"))).toContain("c.glb");
});

it("loads once on screen and stays still until the person plays the preview", async () => {
  await render();
  expect(viewer().getAttribute("loading")).toBe("eager");
  expect(viewer().getAttribute("interaction-prompt")).toBe("none");
  expect(viewer().paused).toBe(true);
  expect(viewer().autoRotate).toBe(false);
  expect(button().getAttribute("aria-label")).toBe("Play 3D preview");
  await click();
  expect(viewer().paused).toBe(false);
  expect(viewer().autoRotate).toBe(true);
  expect(button().getAttribute("aria-label")).toBe("Pause 3D preview");
  await click();
  expect(viewer().paused).toBe(true);
  expect(viewer().autoRotate).toBe(false);
});

it("pauses offscreen and resumes only when playback was requested", async () => {
  await render();
  await click();
  const element = viewer();
  await act(async () => element.visible(false));
  expect(element.paused).toBe(true);
  expect(element.autoRotate).toBe(false);
  expect(element.currentTime).toBe(1);
  await act(async () => element.visible(true));
  expect(element.paused).toBe(false);
  expect(element.autoRotate).toBe(true);
  await click();
  await act(async () => {
    element.visible(false);
    element.visible(true);
  });
  expect(element.paused).toBe(true);
  expect(element.autoRotate).toBe(false);
});

it("stops hidden-page playback and honors a pause after returning", async () => {
  await render();
  await click();
  const changeVisibility = (value: DocumentVisibilityState) =>
    act(async () => {
      visibility = value;
      document.dispatchEvent(new Event("visibilitychange"));
    });
  await changeVisibility("hidden");
  expect(viewer().paused).toBe(true);
  expect(viewer().autoRotate).toBe(false);
  await changeVisibility("visible");
  expect(viewer().paused).toBe(false);
  await click();
  await changeVisibility("hidden");
  await changeVisibility("visible");
  expect(viewer().paused).toBe(true);
});

it("keeps the chosen clip while pausing and resets playback for a new model", async () => {
  await render();
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = "Run";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(viewer().getAttribute("animation-name")).toBe("Run");
  await click();
  await click();
  expect(select.value).toBe("Run");
  const previous = viewer();
  await render("other.glb");
  expect(previous.isConnected).toBe(false);
  expect(previous.paused).toBe(true);
  expect(previous.autoRotate).toBe(false);
  expect(viewer().paused).toBe(true);
  expect(viewer().autoRotate).toBe(false);
  expect(container.querySelector("select")!.value).toBe("Walk");
  previous.play.mockClear();
  previous.pause.mockClear();
  await act(async () => {
    previous.visible(false);
    previous.visible(true);
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(previous.play).not.toHaveBeenCalled();
  expect(previous.pause).not.toHaveBeenCalled();
});

it("keeps thumbnails still without putting controls inside their open button", async () => {
  await render("thumbnail.glb", false);
  expect(viewer().paused).toBe(true);
  expect(viewer().autoRotate).toBe(false);
  expect(container.querySelector("button, select")).toBeNull();
});

it("lets a static model rotate on request without animation clips", async () => {
  await act(async () =>
    root.render(<ModelPreview source="static.glb" label="Prop" />),
  );
  viewer().availableAnimations = [];
  await act(async () => viewer().load());
  expect(container.querySelector("select")).toBeNull();
  await click();
  expect(viewer().autoRotate).toBe(true);
  await click();
  expect(viewer().autoRotate).toBe(false);
});

it("stops a failed preview and removes its playback controls", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await render();
  await click();
  await act(async () =>
    viewer().dispatchEvent(
      new CustomEvent("error", { detail: { type: "webglcontextlost" } }),
    ),
  );
  expect(viewer().paused).toBe(true);
  expect(viewer().autoRotate).toBe(false);
  expect(container.querySelector("[role=alert]")?.textContent).toContain(
    "lost its graphics context",
  );
  expect(container.querySelector("button")).toBeNull();
});
