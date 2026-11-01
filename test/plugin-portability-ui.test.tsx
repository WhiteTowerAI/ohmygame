// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PluginDependencyPanel,
  PluginExportButton,
} from "../src/renderer/plugin-portability.js";
import type { PluginDetail } from "../src/shared/plugins.js";

const plugin: PluginDetail = {
  id: "personal:portable",
  name: "portable",
  displayName: "Portable",
  version: "1.0.0",
  description: "Portable tools",
  marketplace: { id: "personal", displayName: "Personal" },
  source: { type: "archive" },
  installed: true,
  enabled: true,
  skills: [],
  connections: [],
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let requests: Array<{ url: URL; init: RequestInit }>;
let revision: string;
let conflict: boolean;
let exportError: boolean;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests = [];
  revision = "a".repeat(64);
  conflict = false;
  exportError = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url, "http://localhost");
      const route = parsed.pathname.replace(/^\/api/, "");
      requests.push({ url: parsed, init });
      if (route === "/health") return Response.json({ status: "ok" });
      if (route === "/plugins/import/inspect")
        return Response.json({
          plugin,
          marketplace: plugin.marketplace,
          restoresSettings: true,
          existingRevision: revision,
        });
      if (route === "/plugins/import")
        return conflict
          ? Response.json(
              { error: "The installed plugin changed" },
              { status: 409 },
            )
          : Response.json(plugin);
      if (route.endsWith("/export"))
        return exportError
          ? Response.json({ error: "Export unavailable" }, { status: 400 })
          : new Response("zip", {
              headers: { "content-type": "application/zip" },
            });
      if (route.endsWith("/dependencies"))
        return Response.json({
          checks: [
            { code: "command", target: "node", status: "ok" },
            {
              code: "unpinned-package",
              target: "mcp@latest",
              status: "warning",
            },
          ],
        });
      throw new Error(`Unexpected request: ${route}`);
    }),
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
const matching = (suffix: string) =>
  requests.filter((request) => request.url.pathname.endsWith(suffix));
const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === text,
  )!;
describe("plugin archive controls", () => {
  it("downloads exported packages and reports dependency warnings on request", async () => {
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await act(async () =>
      root.render(
        <>
          <PluginExportButton plugin={plugin} />
          <PluginDependencyPanel plugin={plugin} />
        </>,
      ),
    );
    expect(matching("/dependencies")).toHaveLength(0);
    await act(async () => button("Export plugin").click());
    expect(matching("/export")[0]!.url.pathname).toContain(
      encodeURIComponent(plugin.id),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    await act(async () => button("Check dependencies").click());
    expect(matching("/dependencies")).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Check required",
    );
    const checks = [
      ...container.querySelectorAll(".plugin-dependency-checks li"),
    ].map((item) => item.textContent);
    expect(checks).toContain("ReadyCommand: node");
    expect(checks.some((item) => item?.includes("mcp@latest has no fixed package version"))).toBe(true);
    exportError = true;
    await act(async () => button("Export plugin").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Export unavailable",
    );
  });
});
