import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopWindowFrame } from "../src/renderer/desktop-window-frame.js";

afterEach(() => vi.unstubAllGlobals());

describe("DesktopWindowFrame", () => {
  it("renders the Windows application menus in one title bar", () => {
    vi.stubGlobal("window", {
      ohMyGameDesktop: {
        platform: "win32",
        windowMenu: { icon: vi.fn(), popup: vi.fn() },
      },
    });

    const html = renderToStaticMarkup(<DesktopWindowFrame><main>Workspace</main></DesktopWindowFrame>);

    expect(html).toContain('role="menubar"');
    expect(html).toContain('>File</button>');
    expect(html).toContain('>Edit</button>');
    expect(html).toContain('>View</button>');
    expect(html).toContain('>Window</button>');
    expect(html).not.toContain("Project workspace");
    expect(html.match(/desktop-window-menu-bar/g)).toHaveLength(1);
  });

  it("does not add the Windows menu bar in the browser", () => {
    vi.stubGlobal("window", {});
    expect(renderToStaticMarkup(<DesktopWindowFrame><main>Workspace</main></DesktopWindowFrame>))
      .toBe("<main>Workspace</main>");
  });
});
