import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginsSettings } from "../src/renderer/plugins.js";

describe("PluginsSettings", () => {
  it("renders the catalog within Settings", () => {
    const html = renderToStaticMarkup(<PluginsSettings onPluginChange={() => undefined} onTryPlugin={async () => undefined} />);

    expect(html).toContain("<h1>Plugins</h1>");
    expect(html).toContain("Loading plugins");
    expect(html).not.toContain('role="tablist"');
  });

  it("opens plugin details from the route without rendering catalog controls", () => {
    const html = renderToStaticMarkup(<PluginsSettings pluginId="ohmygame:web-game-studio" onPluginChange={() => undefined} onTryPlugin={async () => undefined} />);

    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain("Loading plugin");
    expect(html).not.toContain("Search plugins");
  });
});
