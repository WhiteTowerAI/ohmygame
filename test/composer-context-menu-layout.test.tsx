// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerContextMenu } from "../src/renderer/composer-context-menu.js";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let promptTop = 240;
let paneBottom = 600;

function Composer({
  prompt,
  agent = false,
}: {
  prompt: string;
  agent?: boolean;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const menu = useComposerContextMenu({
    prompt,
    cursor: prompt.length,
    textarea,
    disabled: false,
    capabilities: { plugins: [], skills: [] },
    planning: false,
    canTogglePlanning: true,
    onFiles: vi.fn(),
    onTogglePlanning: vi.fn(),
    onMention: vi.fn(),
    onChange: vi.fn(),
    onSelectionChange: vi.fn(),
  });
  return (
    <div className="desktop-window-content">
      <div className={agent ? "agent-body" : "home-content"}>
        <div className="prompt-box">
          <textarea ref={textarea} />
          {menu.button}
          {menu.overlay}
        </div>
      </div>
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  promptTop = 240;
  paneBottom = 600;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = this.classList.contains("prompt-box")
        ? promptTop
        : this.classList.contains("desktop-window-content")
          ? 32
          : this.classList.contains("agent-body")
            ? 80
            : 0;
      const bottom = this.classList.contains("prompt-box") ? top + 100
        : ["desktop-window-content", "agent-body", "home-content"].some((name) => this.classList.contains(name))
          ? paneBottom
          : top + 100;
      return {
        top,
        bottom,
        left: 0,
        right: 800,
        width: 800,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON() {},
      };
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("composer menu viewport boundaries", () => {
  it.each(["@", "/", ""])(
    "keeps the %s menu below the Windows title bar",
    async (prompt) => {
      await act(async () => root.render(<Composer prompt={prompt} />));
      if (!prompt)
        await act(async () =>
          host
            .querySelector<HTMLButtonElement>(".composer-attach-button")!
            .click(),
        );
      expect(
        host.querySelector<HTMLElement>("[role=listbox]")!.style.maxHeight,
      ).toBe("196px");
      promptTop = 150;
      await act(async () =>
        host.querySelector(".home-content")!.dispatchEvent(new Event("scroll")),
      );
      expect(
        host.querySelector<HTMLElement>("[role=listbox]")!.style.maxHeight,
      ).toBe("106px");
      promptTop = 60;
      await act(async () =>
        host.querySelector(".home-content")!.dispatchEvent(new Event("scroll")),
      );
      const menu = host.querySelector<HTMLElement>("[role=listbox]")!;
      expect(menu.classList.contains("is-below")).toBe(true);
      expect(menu.style.maxHeight).toBe("400px");
    },
  );

  it("also respects the agent pane boundary and a shorter viewport", async () => {
    await act(async () => root.render(<Composer prompt="/" agent />));
    expect(
      host.querySelector<HTMLElement>("[role=listbox]")!.style.maxHeight,
    ).toBe("148px");
    promptTop = 100;
    await act(async () => window.dispatchEvent(new Event("resize")));
    const menu = host.querySelector<HTMLElement>("[role=listbox]")!;
    expect(menu.classList.contains("is-below")).toBe(true);
    expect(menu.style.maxHeight).toBe("388px");
    promptTop = 240;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(menu.classList.contains("is-below")).toBe(false);
    expect(menu.style.maxHeight).toBe("148px");
  });

  it("keeps a usable menu inside the composer when neither side has room", async () => {
    promptTop = 100;
    paneBottom = 220;
    await act(async () => root.render(<Composer prompt="@" agent />));
    const menu = host.querySelector<HTMLElement>("[role=listbox]")!;
    expect(menu.classList.contains("is-inside")).toBe(true);
    expect(menu.classList.contains("is-below")).toBe(false);
    expect(menu.style.top).toBe("0px");
    expect(menu.style.maxHeight).toBe("108px");
    expect(menu.querySelector("[role=option]")).not.toBeNull();
  });
});
