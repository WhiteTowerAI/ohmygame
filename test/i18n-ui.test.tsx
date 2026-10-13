// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

// The saved preference is read once, when the i18n module loads.
localStorage.setItem("ohmygame:language", "zh-CN");
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  getResponsesTransport: vi.fn(async () => ({ mode: "auto" })),
  updateResponsesTransport: vi.fn(),
}));
const { language, t, tNodes } = await import("../src/renderer/i18n.js");
const { ProviderResponsesTransport } =
  await import("../src/renderer/responses-transport-settings.js");
const { CanvasTableAI, ExpandedCanvasTable } =
  await import("../src/renderer/canvas-table-node.js");
const { CanvasTableStorage } =
  await import("../src/renderer/canvas-table-storage.js");
const { createCanvasTable } = await import("../src/shared/canvas-table.js");

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("renders the saved Simplified Chinese preference", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  expect(language).toBe("zh-CN");
  expect(document.documentElement.lang).toBe("zh-CN");
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<ProviderResponsesTransport providerId="relay" />),
  );
  expect(host.querySelector("label")?.textContent).toBe("Responses 连接方式");
  expect(host.querySelector('option[value="auto"]')?.textContent).toBe("自动");
});

it("fills message placeholders with text or React nodes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  expect(t("planStatus.completed", { completed: 2, total: 5 })).toBe(
    "已完成 2 / 5 步",
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <p>
        {tNodes("sendToProject.added", {
          project: <strong>Demo</strong>,
          path: <code>assets/a.png</code>,
        })}
      </p>,
    ),
  );
  expect(host.innerHTML).toBe(
    "<p>已添加到 <strong>Demo</strong>：<code>assets/a.png</code></p>",
  );
});

it("shows table adoption and CSV replacement warnings in Chinese", () => {
  const table = createCanvasTable("Equipment", "items");
  const storage = new CanvasTableStorage("project");
  storage.changeGeneration(table.id, { proposal: table });
  const tables = { storage, open: vi.fn(), add: vi.fn() };
  const candidate = renderToStaticMarkup(
    <CanvasTableAI
      table={table}
      tables={tables}
      textModels={{ models: [], modelStatus: "ready" }}
    />,
  );
  expect(candidate).toContain("候选草稿——请检查后再替换表格。");
  expect(candidate).not.toContain("Candidate draft");
  const editor = renderToStaticMarkup(
    <ExpandedCanvasTable table={table} tables={tables} initialMode="edit" />,
  );
  expect(editor).toContain("导入 CSV 会替换表格，可通过撤销恢复。");
  expect(editor).not.toContain("Paste cells from a spreadsheet");
});
