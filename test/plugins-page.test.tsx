import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PluginsPage } from "../src/renderer/plugins.js";
import { AuthProvider } from "../src/renderer/auth.js";

vi.mock("../src/renderer/app-sidebar.js", () => ({ AppSidebar: () => null }));

describe("PluginsPage", () => {
  it("preserves the Installed and Explore information structure", () => {
    const html = renderToStaticMarkup(<AuthProvider><PluginsPage onNavigate={() => undefined} onAddPlugin={async () => undefined} onTryPlugin={async () => undefined} /></AuthProvider>);

    expect(html).toContain("<h1>Plugins</h1>");
    expect(html).toContain("Loading plugins");
    expect(html).not.toContain('role="tablist"');
  });
});
