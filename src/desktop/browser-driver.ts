import type { WebContents } from "electron";
import type {
  BrowserDriver,
  BrowserPage,
  BrowserUseRequest,
  BrowserUseResult,
} from "../shared/browser-use.js";
import { isBrowserUrl } from "../shared/browser.js";
import type { BrowserViews } from "./browser-views.js";
import {
  abortableDelay,
  FOCUS_TARGET_SCRIPT,
  keyboardEvent,
  TARGET_HELPERS,
  TARGET_POINT_SCRIPT,
} from "./page-input.js";

const INSPECT = `(() => { ${TARGET_HELPERS}
  return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, text: visibleText(), elements: listElements() };
})()`;

/** Operates only the visible project's own Browser panel; never opens a separate hidden browser. */
export class ElectronBrowserDriver implements BrowserDriver {
  readonly available = true;
  readonly #busy = new Set<string>();
  readonly #controllers = new Set<AbortController>();
  constructor(
    private readonly views: BrowserViews,
    private readonly reveal: (projectId: string) => void,
  ) {}

  async request(
    input: BrowserUseRequest,
    signal?: AbortSignal,
  ): Promise<BrowserUseResult> {
    if (this.#busy.has(input.projectId))
      throw new Error(
        "Another agent is using this project's browser; wait for it to finish",
      );
    const controller = new AbortController();
    const cancellation = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(25_000),
      ...(signal ? [signal] : []),
    ]);
    this.#controllers.add(controller);
    this.#busy.add(input.projectId);
    try {
      cancellation.throwIfAborted();
      if (
        (input.operation === "open" || input.operation === "navigate") &&
        (!input.url || !isBrowserUrl(input.url))
      )
        throw new Error("Provide an HTTP or HTTPS URL without credentials");
      this.reveal(input.projectId);
      await this.#wait(
        () => this.views.attached(input.projectId),
        cancellation,
        "Open this project in the desktop app to use its browser",
      );
      if (input.operation === "tabs")
        return { state: this.views.state(input.projectId) };
      let tabId = input.tabId;
      if (input.operation === "open")
        tabId = this.views.open(input.projectId, input.url).active;
      if (!tabId)
        throw new Error(
          "tabId is required; use tabs to see the project's tabs",
        );
      if (input.operation === "close") {
        this.views.close(input.projectId, tabId);
        return { state: this.views.state(input.projectId) };
      }
      this.views.select(input.projectId, tabId);
      if (input.operation === "navigate")
        this.views.navigate(input.projectId, tabId, input.url!);
      const contents = this.views.page(input.projectId, tabId);
      const selectionRevision = this.views.selectionRevision(input.projectId);
      await this.#wait(
        () => this.views.pageVisible(input.projectId, tabId!),
        cancellation,
        "The browser page must be visible; open its panel and try again",
      );
      // Return the current page after a bounded load wait; scripts may keep fetching indefinitely.
      for (
        let attempt = 0;
        attempt < 100 && contents.isLoadingMainFrame();
        attempt++
      )
        await abortableDelay(50, cancellation);
      const check = () => {
        cancellation.throwIfAborted();
        if (
          contents.isDestroyed() ||
          this.views.selectionRevision(input.projectId) !== selectionRevision ||
          !this.views.pageVisible(input.projectId, tabId!)
        )
          throw new Error(
            "The user closed or switched the browser tab; inspect tabs before continuing",
          );
        const error = this.views
          .state(input.projectId)
          .tabs.find((tab) => tab.id === tabId)?.error;
        if (error) throw new Error(error);
      };
      check();
      if (input.operation === "act") {
        if (!input.actions?.length || input.actions.length > 20)
          throw new Error("Provide 1 to 20 browser actions");
        const debuggerApi = contents.debugger;
        const send = (method: string, params: Record<string, unknown>) =>
          cancellable(debuggerApi.sendCommand(method, params), cancellation);
        const owned = !debuggerApi.isAttached();
        if (owned) debuggerApi.attach("1.3");
        try {
          for (const action of input.actions) {
            check();
            if (action.type === "click") {
              const point =
                "x" in action.target
                  ? action.target
                  : await cancellable(
                      contents.executeJavaScript(
                        `(${TARGET_POINT_SCRIPT})(${JSON.stringify(action.target)})`,
                        true,
                      ),
                      cancellation,
                    );
              if (!point)
                throw new Error(
                  "The target was not found; read the page again or use screenshot coordinates",
                );
              await send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                ...point,
              });
              check();
              try {
                await send("Input.dispatchMouseEvent", {
                  type: "mousePressed",
                  ...point,
                  button: "left",
                  clickCount: 1,
                });
              } finally {
                await release("Input.dispatchMouseEvent", {
                  type: "mouseReleased",
                  ...point,
                  button: "left",
                  clickCount: 1,
                });
              }
            } else if (action.type === "type") {
              const focused = await cancellable(
                contents.executeJavaScript(
                  `(${FOCUS_TARGET_SCRIPT})(${JSON.stringify(action.target)})`,
                  true,
                ),
                cancellation,
              );
              if (!focused)
                throw new Error("The target was not found or is not editable");
              check();
              await send("Input.insertText", { text: action.text });
            } else if (action.type === "press") {
              const event = keyboardEvent(action.key);
              try {
                await send("Input.dispatchKeyEvent", {
                  type: "keyDown",
                  ...event,
                });
                await abortableDelay(action.duration ?? 0, cancellation);
              } finally {
                await release("Input.dispatchKeyEvent", {
                  type: "keyUp",
                  ...event,
                });
              }
            } else if (action.type === "scroll") {
              await send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x: action.x,
                y: action.y,
                deltaX: action.deltaX ?? 0,
                deltaY: action.deltaY,
              });
            } else await abortableDelay(action.milliseconds, cancellation);
            await abortableDelay(50, cancellation);
          }
        } finally {
          if (owned && !contents.isDestroyed() && debuggerApi.isAttached())
            debuggerApi.detach();
        }
        async function release(
          method: string,
          params: Record<string, unknown>,
        ) {
          // Release input even after cancellation, but do not hang on a stopped page.
          await cancellable(
            debuggerApi.sendCommand(method, params),
            AbortSignal.timeout(1_000),
          ).catch((error: unknown) => {
            if (!cancellation.aborted && !contents.isDestroyed()) throw error;
          });
        }
      }
      check();
      const page = await cancellable(inspect(contents), cancellation);
      check();
      if (input.operation === "capture") {
        let image = await cancellable(contents.capturePage(), cancellation);
        check();
        if (image.getSize().width > page.viewport.width)
          image = image.resize({ width: page.viewport.width });
        return {
          state: this.views.state(input.projectId),
          page,
          screenshot: {
            ...image.getSize(),
            data: image.toJPEG(80).toString("base64"),
          },
        };
      }
      return { state: this.views.state(input.projectId), page };
    } finally {
      this.#busy.delete(input.projectId);
      this.#controllers.delete(controller);
    }
  }

  close(): void {
    for (const controller of this.#controllers) controller.abort();
  }

  async #wait(
    ready: () => boolean,
    signal: AbortSignal,
    error: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      signal.throwIfAborted();
      if (ready()) return;
      await abortableDelay(50, signal);
    }
    throw new Error(error);
  }
}

async function inspect(contents: WebContents): Promise<BrowserPage> {
  return contents.executeJavaScript(INSPECT, true) as Promise<BrowserPage>;
}

/** A page can stop responding; cancellation must still release this request's ownership. */
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
