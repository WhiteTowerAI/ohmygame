// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PluginDependencyPanel,
  PluginExportButton,
  PluginImportDialog,
} from "../src/renderer/plugin-portability.js";
import {
  PLUGIN_ARCHIVE_MAX_BYTES,
  type PluginDetail,
} from "../src/shared/plugins.js";

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
async function choose(file: File) {
  const input =
    container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () =>
    input.dispatchEvent(new Event("change", { bubbles: true })),
  );
}

describe("plugin archive controls", () => {
  it("previews before import and requires a fresh review after an installation conflict", async () => {
    const installed = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () =>
      root.render(
        <PluginImportDialog onClose={() => {}} onInstalled={installed} />,
      ),
    );
    expect(button("Import plugin").disabled).toBe(true);
    expect(button("Choose file")).not.toBeNull();
    expect(
      container.querySelector(".plugin-file-picker-name")?.textContent,
    ).toBe("No file selected");
    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const openPicker = vi.spyOn(fileInput, "click");
    await act(async () => button("Choose file").click());
    expect(openPicker).toHaveBeenCalledOnce();
    const file = new File(["zip"], "portable.zip", { type: "application/zip" });
    await choose(file);
    expect(
      container.querySelector(".plugin-file-picker-name")?.textContent,
    ).toBe("portable.zip");
    expect(matching("/inspect")[0]!.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: file,
    });
    expect(matching("/import")).toHaveLength(0);
    expect(container.textContent).toContain(
      "This replaces an installed Personal plugin",
    );
    await act(async () => button("Import plugin").click());
    expect(matching("/import")).toHaveLength(0);
    confirm.mockReturnValue(true);
    conflict = true;
    await act(async () => button("Import plugin").click());
    expect(matching("/import")[0]!.url.searchParams.get("revision")).toBe(
      "a".repeat(64),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "changed",
    );
    expect(button("Import plugin").disabled).toBe(true);
    revision = "b".repeat(64);
    await act(async () => button("Review archive again").click());
    conflict = false;
    await act(async () => button("Import plugin").click());
    expect(matching("/import").at(-1)!.url.searchParams.get("revision")).toBe(
      "b".repeat(64),
    );
    expect(installed).toHaveBeenCalledWith(plugin);
  });

  it("rejects oversized archives before uploading and lets the user cancel", async () => {
    const close = vi.fn();
    await act(async () =>
      root.render(
        <PluginImportDialog onClose={close} onInstalled={() => {}} />,
      ),
    );
    const file = new File(["zip"], "large.zip");
    Object.defineProperty(file, "size", {
      value: PLUGIN_ARCHIVE_MAX_BYTES + 1,
    });
    await choose(file);
    expect(matching("/inspect")).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "50 MB",
    );
    await act(async () => button("Cancel").click());
    expect(close).toHaveBeenCalledOnce();
  });

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
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Ready · Command: node",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "mcp@latest has no fixed package version",
    );
    exportError = true;
    await act(async () => button("Export plugin").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Export unavailable",
    );
  });
});
