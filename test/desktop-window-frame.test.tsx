import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopWindowFrame } from "../src/renderer/desktop-window-frame.js";

afterEach(() => vi.unstubAllGlobals());

const windowControls = () => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  state: vi.fn(async () => ({ maximized: false })),
  onState: vi.fn(() => () => {}),
});

describe("DesktopWindowFrame", () => {
  it("lays the window's controls over the page instead of a title bar row", () => {
    vi.stubGlobal("window", {
      ohMyGameDesktop: {
        platform: "win32",
        windowMenu: { setLabels: vi.fn() },
        windowControls: windowControls(),
      },
    });

    const html = renderToStaticMarkup(<DesktopWindowFrame><main>Workspace</main></DesktopWindowFrame>);

    expect(html).toContain("<main>Workspace</main>");
    expect(html).not.toContain('role="menubar"');
    expect(html).not.toContain('aria-label="Back"');
    expect(html.indexOf("<main>")).toBeLessThan(html.indexOf("desktop-window-controls"));
    expect(html).toContain('aria-label="Minimize"');
    expect(html).toContain('aria-label="Maximize"');
    expect(html).toContain('aria-label="Close"');
  });

  it("leaves macOS to the title bar it had before", () => {
    vi.stubGlobal("window", {
      ohMyGameDesktop: {
        platform: "darwin",
        windowMenu: { setLabels: vi.fn() },
        windowControls: windowControls(),
      },
    });

    expect(renderToStaticMarkup(<DesktopWindowFrame><main>Workspace</main></DesktopWindowFrame>))
      .toBe("<main>Workspace</main>");
  });

  it("does not add the Windows frame in the browser", () => {
    vi.stubGlobal("window", {});
    expect(renderToStaticMarkup(<DesktopWindowFrame><main>Workspace</main></DesktopWindowFrame>))
      .toBe("<main>Workspace</main>");
  });
});
